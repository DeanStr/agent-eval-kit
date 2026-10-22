import path from "node:path";
import type { RunReport } from "./types.js";

export const JSON_RESULT_COMMANDS = new Set([
  "run",
  "collect",
  "campaign",
  "campaign compare",
  "judge",
  "judge validate",
  "validate",
  "list",
  "doctor",
  "verify",
  "compare",
  "rescore",
  "finalize",
  "adjudicate",
  "improve install",
  "improve start",
  "improve attempt",
  "improve evaluate",
  "improve status",
  "improve stop",
]);

/** The CLI owns stdout; progress remains separate from its final JSON result. */
export class CliOutput {
  private value: unknown;
  context: { runDir?: string; campaignDir?: string; sessionDir?: string } = {};

  constructor(
    readonly command: string,
    readonly json: boolean,
    readonly debug: boolean,
    private readonly expectsResult: boolean,
  ) {}

  log = (message: string): void => {
    if (this.json) console.error(message);
    else console.log(message);
  };

  result(value: unknown): void {
    this.value = value;
  }

  finish(error?: unknown): void {
    if (this.json && this.expectsResult && error === undefined && this.value === undefined)
      throw new Error(`Missing structured CLI result for ${this.command}`);
    const exitCode = Number(process.exitCode ?? 0);
    const interrupted = exitCode === 130 || exitCode === 143;
    // Signal handling already explains the interruption on stderr.
    if (error !== undefined && (!interrupted || this.debug))
      console.error(
        error instanceof Error
          ? this.debug
            ? (error.stack ?? error.message)
            : `Error: ${error.message}`
          : String(error),
      );
    if (!this.json || (error === undefined && this.value === undefined)) return;
    console.log(
      JSON.stringify({
        version: 1,
        command: this.command,
        status: interrupted
          ? "interrupted"
          : exitCode === 0
            ? "completed"
            : exitCode === 2
              ? "acceptance_failed"
              : "error",
        exitCode,
        result: error === undefined ? this.value : null,
        ...(Object.keys(this.context).length ? { context: this.context } : {}),
        ...(error === undefined
          ? {}
          : { error: { message: error instanceof Error ? error.message : String(error) } }),
      }),
    );
  }
}

export function runResult(runDir: string, report: RunReport, acceptanceFailures: string[]) {
  return {
    runId: report.runId,
    runDir,
    execution: "complete",
    project: report.project,
    scorePct: report.scoreWithheld ? null : report.overallScorePct,
    provisionalScorePct: report.scoreWithheld ? report.overallScorePct : null,
    coveragePct: report.overallCoveragePct,
    scoreWithheld: report.scoreWithheld,
    gates: report.gates,
    manualPending: report.manualPending,
    acceptanceFailures,
    artifacts: {
      report: path.join(runDir, "report.json"),
      html: path.join(runDir, "report.html"),
    },
  };
}
