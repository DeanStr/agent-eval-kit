import path from "node:path";
import type { CliOutput } from "../cli-output.js";
import { omitUndefined } from "../invariants.js";
import { installImprovementSkill } from "./install.js";
import {
  beginAttempt,
  evaluateAttempt,
  improvementStatus,
  startImprovement,
  stopImprovement,
  ImprovementSessionError,
} from "./session.js";

export async function improvementCommand(
  subcommand: string,
  flags: Record<string, string | boolean>,
  output: CliOutput,
): Promise<void> {
  function string(name: string): string | undefined {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} requires a value`);
    return value;
  }
  function required(name: string): string {
    const value = string(name);
    if (value === undefined) throw new Error(`improve ${subcommand} requires --${name}`);
    return value;
  }
  function number(name: string): number | undefined {
    const value = string(name);
    return value === undefined ? undefined : Number(value);
  }
  async function withSessionContext<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ImprovementSessionError) output.context.session = error.session;
      throw error;
    }
  }
  if (subcommand === "install") {
    const installed = installImprovementSkill(string("directory") ?? ".agents/skills");
    output.log(`Installed aek-improve: ${installed}`);
    output.result({ directory: installed });
    return;
  }
  const directory = path.resolve(required(subcommand === "start" ? "output" : "session"));
  output.context.sessionDir = directory;
  switch (subcommand) {
    case "start": {
      const session = await withSessionContext(() =>
        startImprovement(
          {
            config: string("config") ?? "evalkit.yaml",
            output: directory,
            goal: required("goal"),
            ...omitUndefined({
              suite: string("suite"),
              maxAttempts: number("max-attempts"),
              maxStalls: number("max-stalls"),
              budgetSeconds: number("budget-seconds"),
              minimumGain: number("minimum-gain"),
            }),
          },
          output.log,
        ),
      );
      if (session.status === "stopped") process.exitCode = 2;
      break;
    }
    case "attempt": {
      const session = await beginAttempt(directory, required("hypothesis"));
      if (session.status === "stopped") process.exitCode = 2;
      break;
    }
    case "evaluate": {
      const session = await withSessionContext(() =>
        evaluateAttempt(directory, string("guidance"), output.log),
      );
      if (session.attempts.at(-1)?.status !== "accepted") process.exitCode = 2;
      break;
    }
    case "stop":
      await stopImprovement(directory, required("reason"));
      break;
    case "status":
      break;
    default:
      throw new Error(`Unknown improve subcommand: ${subcommand}`);
  }
  const result = improvementStatus(directory);
  output.result(result);
  output.log(
    `Session: ${result.status}${result.stopReason ? ` (${result.stopReason})` : ""}\nWorkspace: ${result.workspace}`,
  );
  if (result.best)
    output.log(
      `Best checkpoint: ${result.best.checkpoint}${result.best.accepted ? " (accepted improvement)" : " (initial baseline)"}`,
    );
  const attempt = result.attempts.at(-1);
  if (attempt)
    output.log(
      `Attempt ${attempt.number}: ${attempt.status}${attempt.reasons.length ? `\n${attempt.reasons.join("\n")}` : ""}`,
    );
  if (result.cleanup)
    output.log(
      `Once the result and evidence are no longer needed, remove the workspace and retained candidate commits:\n${result.cleanup.join("\n")}`,
    );
  if (result.cleanupBlockedReason)
    output.log(`Cleanup unavailable: ${result.cleanupBlockedReason}`);
}
