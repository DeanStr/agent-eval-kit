import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderInvocation, ProviderResult } from "../types.js";
import { stageCredentials } from "./credentials.js";
import {
  assertSafeProviderExtraArgs,
  parseJsonText,
  playwrightBrowsersPath,
  spawnCaptured,
  stringifyCommand,
  subscriptionEnvironment,
} from "./process.js";

export function grokAuthPath(environment: NodeJS.ProcessEnv = process.env): string {
  const grokHome = path.resolve(environment.GROK_HOME ?? path.join(os.homedir(), ".grok"));
  return path.join(grokHome, "auth.json");
}

export async function runGrok(invocation: ProviderInvocation): Promise<ProviderResult> {
  assertSafeProviderExtraArgs("grok", invocation.extraArgs);
  const schema = fs.readFileSync(invocation.outputSchemaFile, "utf8");
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aek-grok-"));
  const isolatedHome = path.join(isolationRoot, "home");
  const isolatedGrokHome = path.join(isolatedHome, ".grok");
  const isolatedWork = path.join(isolationRoot, "work");
  let persistCredentials: (() => void) | undefined;
  try {
    fs.mkdirSync(isolatedGrokHome, { recursive: true });
    fs.mkdirSync(isolatedWork);
    const authFile = grokAuthPath();
    const sourceGrokHome = path.dirname(authFile);
    if (!fs.existsSync(authFile) || !fs.statSync(authFile).isFile()) {
      throw new Error(`Grok subscription auth was not found at ${authFile}; run \`grok login\` first`);
    }
    for (const name of ["auth.json", "agent_id", ".metadata_version"]) {
      const source = path.join(sourceGrokHome, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const destination = path.join(isolatedGrokHome, name);
      if (name === "auth.json") persistCredentials = stageCredentials(source, destination);
      else {
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
      }
    }
    if (invocation.mcp) fs.copyFileSync(invocation.mcp.configFile, path.join(isolatedWork, ".mcp.json"));
    const args = ["--no-auto-update", ...invocation.extraArgs];
    // Evaluator-controlled scalars follow project-supplied extras so duplicate
    // flags cannot override the receipted model, effort, or turn budget.
    if (invocation.model) args.push("--model", invocation.model);
    if (invocation.effort) args.push("--reasoning-effort", invocation.effort);
    if (invocation.maxTurns) args.push("--max-turns", String(invocation.maxTurns));
    // Append the evidence-boundary flags after configurable arguments so a
    // project config cannot move Grok back under the target repository or
    // silently re-enable its built-in inspection tools.
    args.push(
      "--cwd",
      isolatedWork,
      "--prompt-file",
      invocation.promptFile,
      "--output-format",
      "json",
      "--json-schema",
      schema,
      "--no-subagents",
      "--disable-web-search",
      "--permission-mode",
      "dontAsk",
      "--verbatim",
    );
    if (invocation.mcp) args.push("--allow", `MCPTool(${invocation.mcp.name}__*)`);
    args.push("--tools", invocation.allowWorkspaceTools ? "Read,Glob,Grep,Bash" : "");
    args.push(
      "--disallowed-tools",
      invocation.allowWorkspaceTools
        ? "Edit,Write,WebFetch,WebSearch"
        : "Read,Glob,Grep,Bash,Edit,Write,WebFetch,WebSearch",
    );
    const environment = subscriptionEnvironment("grok");
    environment.HOME = isolatedHome;
    environment.USERPROFILE = isolatedHome;
    environment.GROK_HOME = isolatedGrokHome;
    environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
    for (const name of [
      "GROK_CURSOR_SKILLS_ENABLED",
      "GROK_CURSOR_RULES_ENABLED",
      "GROK_CURSOR_AGENTS_ENABLED",
      "GROK_CURSOR_MCPS_ENABLED",
      "GROK_CURSOR_HOOKS_ENABLED",
      "GROK_CLAUDE_SKILLS_ENABLED",
      "GROK_CLAUDE_RULES_ENABLED",
      "GROK_CLAUDE_AGENTS_ENABLED",
      "GROK_CLAUDE_MCPS_ENABLED",
      "GROK_CLAUDE_HOOKS_ENABLED",
    ]) environment[name] = "0";

    const result = await spawnCaptured({
      command: "grok",
      args,
      cwd: isolatedWork,
      env: environment,
      timeoutSeconds: invocation.timeoutSeconds,
      stdoutFile: invocation.eventLogFile,
      stderrFile: invocation.stderrFile,
    });
    let structured = parseJsonText(result.stdout);
    let finalText = result.stdout.trim();
    let sessionId: string | undefined;
    let usage: Record<string, number> | undefined;
    if (structured && typeof structured === "object") {
      const outer = structured as Record<string, unknown>;
      sessionId = typeof outer.session_id === "string" ? outer.session_id : undefined;
      usage = outer.usage && typeof outer.usage === "object" ? (outer.usage as Record<string, number>) : undefined;
      if (outer.structured_output !== undefined) structured = outer.structured_output;
      else if (outer.result !== undefined) {
        finalText = typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result);
        structured = typeof outer.result === "string" ? parseJsonText(outer.result) : outer.result;
      }
    }
    fs.writeFileSync(invocation.outputFile, finalText);
    return {
      provider: "grok",
      ...result,
      finalText,
      structured,
      sessionId,
      usage,
      command: stringifyCommand("grok", args),
    };
  } finally {
    try {
      persistCredentials?.();
    } finally {
      fs.rmSync(isolationRoot, { recursive: true, force: true });
    }
  }
}
