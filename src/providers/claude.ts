import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderInvocation, ProviderResult, ProviderUsage } from "../types.js";
import { stageCredentials } from "./credentials.js";
import {
  assertSafeProviderExtraArgs,
  parseJsonText,
  playwrightBrowsersPath,
  spawnCaptured,
  stringifyCommand,
  subscriptionEnvironment,
  withIsolatedProviderDirectory,
} from "./process.js";

export async function runClaude(invocation: ProviderInvocation): Promise<ProviderResult> {
  assertSafeProviderExtraArgs("claude", invocation.extraArgs);
  return withIsolatedProviderDirectory("claude", async (isolationRoot) => {
    const workingDirectory = path.join(isolationRoot, "work");
    const isolatedHome = path.join(isolationRoot, "home");
    const isolatedConfig = path.join(isolatedHome, ".claude");
    fs.mkdirSync(workingDirectory);
    fs.mkdirSync(isolatedConfig, { recursive: true });

    // Safe mode also disables an explicitly supplied evidence MCP. Isolate the
    // configuration home instead, copying only subscription credentials and
    // leaving user memories, settings, plugins, hooks, and sessions behind.
    const sourceConfig = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
    const credentials = path.join(sourceConfig, ".credentials.json");
    let persistCredentials: (() => void) | undefined;
    if (fs.existsSync(credentials) && fs.statSync(credentials).isFile()) {
      const destination = path.join(isolatedConfig, ".credentials.json");
      persistCredentials = stageCredentials(credentials, destination);
    }
    const environment = subscriptionEnvironment("claude");
    environment.HOME = isolatedHome;
    environment.USERPROFILE = isolatedHome;
    environment.CLAUDE_CONFIG_DIR = isolatedConfig;
    environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
    try {
      return await runIsolatedClaude(invocation, workingDirectory, environment);
    } finally {
      // OAuth refresh tokens may rotate. Discarding the refreshed isolated
      // copy would leave the next scenario with an invalid old credential.
      persistCredentials?.();
    }
  });
}

async function runIsolatedClaude(
  invocation: ProviderInvocation,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProviderResult> {
  const schema = fs.readFileSync(invocation.outputSchemaFile, "utf8");
  const args = ["-p", ...invocation.extraArgs];
  // Boundary and output options follow project-supplied extras so ordinary
  // duplicate scalar options cannot win by argument order.
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--restricted",
    "--permission-mode",
    "dontAsk",
    "--json-schema",
    schema,
  );
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort) args.push("--effort", invocation.effort);
  if (invocation.maxTurns) args.push("--max-turns", String(invocation.maxTurns));
  for (const directory of invocation.additionalDirs ?? []) args.push("--add-dir", directory);
  if (invocation.mcp) {
    args.push("--mcp-config", invocation.mcp.configFile, "--strict-mcp-config");
    const tools = invocation.mcp.toolNames.map((name) => `mcp__${invocation.mcp!.name}__${name}`);
    if (invocation.allowWorkspaceTools) tools.push("Read", "Glob", "Grep", "Bash");
    args.push("--tools", tools.join(","), "--allowed-tools", tools.join(","));
  } else if (invocation.allowWorkspaceTools) {
    args.push("--tools", "Read,Glob,Grep,Bash", "--allowed-tools", "Read,Glob,Grep,Bash");
  } else if (invocation.purpose === "judge") {
    args.push("--tools", "", "--allowed-tools", "");
  } else {
    args.push("--tools", "Read,Glob,Grep", "--allowed-tools", "Read,Glob,Grep");
  }
  let finalText = "";
  let structured: unknown;
  let sessionId: string | undefined;
  let usage: ProviderUsage | undefined;
  let eventLine = 0;
  let malformedEventLine: number | undefined;
  const policyViolations = new Set<string>();
  const result = await spawnCaptured({
    command: "claude",
    args,
    cwd: workingDirectory,
    stdin: fs.readFileSync(invocation.promptFile, "utf8"),
    env: environment,
    timeoutSeconds: invocation.timeoutSeconds,
    stdoutFile: invocation.eventLogFile,
    stderrFile: invocation.stderrFile,
    onLine(stream, line) {
      if (stream !== "stdout") return;
      eventLine += 1;
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        sessionId = event.session_id ?? sessionId;
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              // Claude Code implements --json-schema through this built-in
              // schema sink. It cannot inspect the target and is required for
              // every structured result, so it is part of the output channel,
              // not a breach of the evidence boundary.
              const structuredOutput = block.name === "StructuredOutput";
              const allowedMcpTool = invocation.mcp &&
                String(block.name).startsWith(`mcp__${invocation.mcp.name}__`);
              if (!invocation.allowWorkspaceTools && !structuredOutput && !allowedMcpTool) {
                policyViolations.add(String(block.name));
              }
              invocation.onProgress?.(`tool ${String(block.name).replace(/^mcp__[^_]+__/, "")}`);
            }
          }
        }
        if (event.type === "result") {
          finalText = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
          structured = event.structured_output ?? parseJsonText(finalText);
          usage = event.usage ?? usage;
        }
      } catch {
        malformedEventLine ??= eventLine;
      }
    },
  });
  if (malformedEventLine !== undefined) {
    throw new Error(
      `Claude emitted malformed stream-json output at line ${malformedEventLine}; see ${invocation.eventLogFile}`,
    );
  }
  if (structured === undefined) structured = parseJsonText(finalText);
  fs.writeFileSync(invocation.outputFile, finalText);
  return {
    provider: "claude",
    ...result,
    finalText,
    structured,
    sessionId,
    usage,
    command: stringifyCommand("claude", args),
    policyViolations: [...policyViolations],
  };
}
