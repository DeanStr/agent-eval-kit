import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderInvocation, ProviderResult, ProviderUsage } from "../types.js";
import { stageCredentials } from "./credentials.js";
import {
  parseJsonText,
  playwrightBrowsersPath,
  spawnCaptured,
  subscriptionEnvironment,
  withIsolatedProviderDirectory,
} from "./process.js";

const cursorEventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  message: z
    .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    .optional(),
  tool_call: z
    .preprocess(
      (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        // These are ToolCall envelope fields, not invoked tools.
        const metadata = new Set([
          "hookAdditionalContexts",
          "toolCallId",
          "startedAtMs",
          "completedAtMs",
        ]);
        return Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
      },
      z.record(
        z.string(),
        z.object({
          args: z
            .object({ providerIdentifier: z.string().optional(), toolName: z.string().optional() })
            .optional(),
        }),
      ),
    )
    .optional(),
});

export function cursorAuthPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME ?? os.homedir();
  return path.resolve(
    process.platform === "darwin"
      ? path.join(home, ".cursor")
      : path.join(environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "cursor"),
    "auth.json",
  );
}

export async function runCursor(invocation: ProviderInvocation): Promise<ProviderResult> {
  // Cursor's options include configuration, endpoint and session overrides.
  // Keep this surface closed until individual options have a supported contract.
  if (invocation.extraArgs.length)
    throw new Error("Cursor extraArgs are unsupported; use the model and timeoutSeconds settings");
  if (invocation.effort !== undefined || invocation.maxTurns !== undefined)
    throw new Error(
      "Cursor does not support effort or maxTurns settings; configure model and timeoutSeconds instead",
    );
  if (invocation.images?.length)
    throw new Error("Cursor image attachments must be supplied through the evidence MCP");
  const authFile = cursorAuthPath();
  if (!fs.existsSync(authFile) || !fs.statSync(authFile).isFile())
    throw new Error(
      `Cursor subscription auth was not found at ${authFile}; run \`AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login\` first`,
    );

  return withIsolatedProviderDirectory("cursor", async (root) => {
    const home = path.join(root, "home");
    const work = path.join(root, "work");
    const config = path.join(home, ".cursor");
    const environment = subscriptionEnvironment();
    environment.HOME = home;
    environment.USERPROFILE = home;
    environment.XDG_CONFIG_HOME = path.join(home, ".config");
    environment.CURSOR_CONFIG_DIR = config;
    environment.CURSOR_DATA_DIR = config;
    environment.AGENT_CLI_CREDENTIAL_STORE = "file";
    environment.DIRENV_DISABLE = "1";
    environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
    const destination = cursorAuthPath(environment);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(path.join(work, ".cursor"), { recursive: true });
    const persistCredentials = stageCredentials(authFile, destination);
    try {
      const allow = invocation.mcp
        ? invocation.mcp.toolNames.map((tool) => `Mcp(${invocation.mcp!.name}:${tool})`)
        : [];
      if (invocation.allowWorkspaceTools) allow.push("Read(**)", "Shell(*)");
      const deny = ["Write(**)", "WebFetch(*)"];
      if (!invocation.allowWorkspaceTools) deny.push("Read(**)", "Shell(*)");
      fs.writeFileSync(
        path.join(config, "cli-config.json"),
        JSON.stringify({
          version: 1,
          editor: { vimMode: false },
          permissions: { allow, deny },
          approvalMode: "allowlist",
        }),
      );
      if (invocation.mcp) {
        // Cursor filters inherited MCP environment variables. Set the resolved
        // browser cache explicitly so HOME isolation does not hide Chromium.
        fs.writeFileSync(
          path.join(work, ".cursor", "mcp.json"),
          JSON.stringify({
            mcpServers: {
              [invocation.mcp.name]: {
                command: invocation.mcp.command,
                args: invocation.mcp.args,
                env: { PLAYWRIGHT_BROWSERS_PATH: environment.PLAYWRIGHT_BROWSERS_PATH },
              },
            },
          }),
        );
      }
      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--trust",
        "--approve-mcps",
        "--workspace",
        work,
      ];
      if (invocation.model) args.push("--model", invocation.model);
      const prompt = `${fs.readFileSync(invocation.promptFile, "utf8")}\n\nReturn only a JSON value matching this JSON Schema in your final answer. Do not include commentary or markdown:\n${fs.readFileSync(invocation.outputSchemaFile, "utf8")}`;
      let finalText = "";
      let finalTextSource: ProviderResult["finalTextSource"];
      let responseEmitted = false;
      let sessionId: string | undefined;
      let usage: ProviderUsage | undefined;
      let terminal: "success" | "error" | undefined;
      let lastAssistantText: string | undefined;
      const violations = new Set<string>();
      const result = await spawnCaptured({
        command: "cursor-agent",
        args,
        cwd: work,
        stdin: prompt,
        env: environment,
        timeoutSeconds: invocation.timeoutSeconds,
        stdoutFile: invocation.eventLogFile,
        stderrFile: invocation.stderrFile,
        onLine(stream, line) {
          if (stream !== "stdout" || !line.trim()) return;
          let event: z.infer<typeof cursorEventSchema>;
          try {
            event = cursorEventSchema.parse(JSON.parse(line));
          } catch {
            throw new Error(`Cursor emitted malformed stream-json; see ${invocation.eventLogFile}`);
          }
          if (!event || typeof event !== "object" || typeof event.type !== "string")
            throw new Error(`Cursor emitted an invalid event; see ${invocation.eventLogFile}`);
          if (typeof event.session_id === "string") sessionId = event.session_id;
          if (event.type === "assistant") {
            if (!Array.isArray(event.message?.content))
              throw new Error(
                `Cursor emitted an invalid assistant event; see ${invocation.eventLogFile}`,
              );
            lastAssistantText = event.message.content
              .filter((block: { type: string }) => block.type === "text")
              .map((block) => {
                if (typeof block.text !== "string")
                  throw new Error(
                    `Cursor emitted invalid assistant text; see ${invocation.eventLogFile}`,
                  );
                return block.text;
              })
              .join("");
            if (lastAssistantText.trim()) responseEmitted = true;
          }
          if (event.type === "tool_call") {
            const calls = event.tool_call;
            if (!calls || typeof calls !== "object" || !Object.keys(calls).length)
              throw new Error(
                `Cursor emitted an invalid tool event; see ${invocation.eventLogFile}`,
              );
            for (const [name, call] of Object.entries(calls)) {
              const tool = call;
              const mcp =
                name === "mcpToolCall" &&
                invocation.mcp &&
                tool?.args?.providerIdentifier === invocation.mcp.name &&
                invocation.mcp.toolNames.includes(tool?.args?.toolName ?? "");
              const workspace =
                invocation.allowWorkspaceTools &&
                [
                  "readToolCall",
                  "lsToolCall",
                  "grepToolCall",
                  "globToolCall",
                  "shellToolCall",
                ].includes(name);
              // Discovery only sees the isolated, evaluator-supplied MCP config.
              const discovery = name === "getMcpToolsToolCall" && invocation.mcp;
              // Todos are scoped to this fresh session and cannot read target
              // files, invoke commands, or supply external evidence.
              const bookkeeping = name === "updateTodosToolCall" || name === "readTodosToolCall";
              if (!mcp && !workspace && !discovery && !bookkeeping) violations.add(name);
              if (event.subtype === "started")
                invocation.onProgress?.(`tool ${tool?.args?.toolName ?? name}`);
            }
          }
          if (event.type === "result") {
            const failed = event.subtype === "error" && event.is_error === true;
            if (
              terminal ||
              (!failed &&
                (event.subtype !== "success" ||
                  event.is_error !== false ||
                  typeof event.result !== "string"))
            )
              throw new Error(
                `Cursor returned an invalid or failed result; see ${invocation.eventLogFile}`,
              );
            terminal = failed ? "error" : "success";
            usage = event.usage;
            // Cursor's result concatenates all assistant messages, including
            // pre-tool narration. The last complete assistant message is the answer.
            // Preserve that decision on failure too, so retries cannot reroll it.
            finalText = lastAssistantText ?? event.result ?? "";
            finalTextSource = failed && lastAssistantText === undefined ? "error" : "response";
          }
        },
      });
      // A failed process can exit after answering but before emitting a result event.
      if (!terminal && lastAssistantText !== undefined) {
        finalText = lastAssistantText;
        finalTextSource = "response";
      }
      fs.writeFileSync(invocation.outputFile, finalText);
      if (result.exitCode === 0 && !result.timedOut && terminal === "error")
        throw new Error(
          `Cursor returned a failed result with exit code 0; see ${invocation.eventLogFile}`,
        );
      if (result.exitCode === 0 && !result.timedOut && !terminal)
        throw new Error(`Cursor ended without a terminal result; see ${invocation.eventLogFile}`);
      return {
        provider: "cursor",
        ...result,
        finalText,
        ...(finalTextSource === undefined ? {} : { finalTextSource }),
        ...(responseEmitted ? { responseEmitted: true } : {}),
        structured: parseJsonText(finalText),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(usage === undefined ? {} : { usage }),
        command: ["cursor-agent", ...args],
        policyViolations: [...violations],
      };
    } finally {
      persistCredentials();
    }
  });
}
