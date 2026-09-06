import fs from "node:fs";
import type { ProviderInvocation, ProviderResult, ProviderUsage } from "../types.js";
import {
  assertSafeProviderExtraArgs,
  parseJsonText,
  spawnCaptured,
  stringifyCommand,
  subscriptionEnvironment,
  withIsolatedProviderDirectory,
} from "./process.js";

const toml = (value: string) => JSON.stringify(value);
const tomlArray = (values: string[]) => `[${values.map(toml).join(",")}]`;

export async function runCodex(invocation: ProviderInvocation): Promise<ProviderResult> {
  assertSafeProviderExtraArgs("codex", invocation.extraArgs);
  return withIsolatedProviderDirectory("codex", (workingDirectory) =>
    runIsolatedCodex(invocation, workingDirectory),
  );
}

async function runIsolatedCodex(
  invocation: ProviderInvocation,
  workingDirectory: string,
): Promise<ProviderResult> {
  const args = ["exec", ...invocation.extraArgs];
  // Put every evaluator-controlled scalar after extraArgs so project settings
  // cannot override the receipted model, output contract, working directory,
  // sandbox, or MCP boundary. Additive/bypass flags are rejected above.
  args.push(
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
  );
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort) args.push("--config", `model_reasoning_effort=${toml(invocation.effort)}`);
  args.push(
    "--cd",
    workingDirectory,
    "--output-schema",
    invocation.outputSchemaFile,
    "--output-last-message",
    invocation.outputFile,
  );
  if (invocation.mcp) {
    // Non-interactive Codex cannot stop for a human MCP approval. Delegate
    // those decisions to Codex's built-in automatic reviewer while retaining
    // the workspace-write sandbox; this is narrower than bypassing approvals
    // and sandboxing altogether.
    args.push("--approve-for-me");
    args.push(
      "--config",
      `mcp_servers.${invocation.mcp.name}.command=${toml(invocation.mcp.command)}`,
      "--config",
      `mcp_servers.${invocation.mcp.name}.args=${tomlArray(invocation.mcp.args)}`,
      "--config",
      `mcp_servers.${invocation.mcp.name}.required=true`,
      // Atomic tools such as email login can exceed Codex's 60-second default.
      // The invocation's existing process deadline remains the outer bound.
      "--config",
      `mcp_servers.${invocation.mcp.name}.tool_timeout_sec=${invocation.timeoutSeconds}`,
    );
  } else {
    args.push("--sandbox", "read-only");
  }
  for (const image of invocation.images ?? []) args.push("--image", image);
  args.push("-");

  let sessionId: string | undefined;
  let usage: ProviderUsage | undefined;
  let eventLine = 0;
  let malformedEventLine: number | undefined;
  const policyViolations = new Set<string>();
  const result = await spawnCaptured({
    command: "codex",
    args,
    cwd: workingDirectory,
    stdin: fs.readFileSync(invocation.promptFile, "utf8"),
    env: subscriptionEnvironment(),
    timeoutSeconds: invocation.timeoutSeconds,
    stdoutFile: invocation.eventLogFile,
    stderrFile: invocation.stderrFile,
    onLine(stream, line) {
      if (stream !== "stdout") return;
      eventLine += 1;
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started") sessionId = event.thread_id;
        if (event.type === "turn.completed" && event.usage) usage = event.usage;
        if (event.type === "item.started" && event.item?.type === "mcp_tool_call") {
          invocation.onProgress?.(`tool ${event.item.tool}`);
        }
        if (
          !invocation.allowWorkspaceTools &&
          ["command_execution", "file_change", "web_search"].includes(event.item?.type)
        ) {
          policyViolations.add(String(event.item.type));
        }
      } catch {
        malformedEventLine ??= eventLine;
      }
    },
  });
  if (malformedEventLine !== undefined) {
    throw new Error(
      `Codex emitted malformed JSON event output at line ${malformedEventLine}; see ${invocation.eventLogFile}`,
    );
  }
  if (result.exitCode === 0 && !fs.existsSync(invocation.outputFile)) {
    throw new Error(
      `Codex completed without writing its required output file: ${invocation.outputFile}`,
    );
  }
  const finalText = fs.existsSync(invocation.outputFile)
    ? fs.readFileSync(invocation.outputFile, "utf8")
    : "";
  return {
    provider: "codex",
    ...result,
    finalText,
    structured: parseJsonText(finalText),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(usage === undefined ? {} : { usage }),
    command: stringifyCommand("codex", args),
    policyViolations: [...policyViolations],
  };
}
