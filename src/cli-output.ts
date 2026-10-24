import path from "node:path";
import { colorEnabled, paint, type Tone } from "./terminal.js";
import type { RunReport } from "./types.js";
import type { ImprovementSessionContext } from "./improvement/contracts.js";

export const JSON_RESULT_COMMANDS = new Set([
  "run",
  "check",
  "runs list",
  "runs prune",
  "skills install",
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
  context: {
    runDir?: string;
    campaignDir?: string;
    sessionDir?: string;
    session?: ImprovementSessionContext;
  } = {};

  constructor(
    readonly command: string,
    readonly json: boolean,
    readonly debug: boolean,
    private readonly expectsResult: boolean,
  ) {}

  /** Recent progress, so an error already shown in full (a FATAL line) is not repeated. */
  private readonly recent: string[] = [];

  log = (message: string, tone?: Tone): void => {
    this.recent.push(message);
    if (this.recent.length > 20) this.recent.shift();
    if (this.json) console.error(paint(message, tone, colorEnabled(process.stderr)));
    else console.log(paint(message, tone, colorEnabled(process.stdout)));
  };

  /** Diagnostics that belong on stderr even without --json, such as acceptance failures. */
  warn = (message: string, tone: Tone = "fail"): void => {
    console.error(paint(message, tone, colorEnabled(process.stderr)));
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
        paint(
          error instanceof Error
            ? this.debug
              ? (error.stack ?? error.message)
              : this.recent.some((message) => message.includes(error.message))
                ? `Error: ${error.message.split("\n", 1)[0]} (full details above${this.context.runDir ? ` and in ${path.join(this.context.runDir, "run.log")}` : ""})`
                : `Error: ${error.message}`
            : String(error),
          "fail",
          colorEnabled(process.stderr),
        ),
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
  const gates = new Map(
    report.areas.flatMap((area) => area.gates.map((gate) => [`${area.id}/${gate.itemId}`, gate])),
  );
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
    // Every judged or pending criterion, so callers need not parse report.json.
    items: report.areas.flatMap((area) => [
      ...area.items.map((item) => ({
        areaId: area.id,
        itemId: item.id,
        verdict: item.verdict,
        confidence: item.confidence,
        source: item.source,
        gate: gates.get(`${area.id}/${item.id}`)?.status ?? null,
        unproven: area.unproven.includes(item.id),
        manualPending: area.pendingManual.includes(item.id),
        reasoning: item.reasoning,
      })),
      ...area.pendingManual
        .filter((id) => !area.items.some((item) => item.id === id))
        .map((id) => ({
          areaId: area.id,
          itemId: id,
          verdict: null,
          confidence: null,
          source: "manual",
          gate: gates.get(`${area.id}/${id}`)?.status ?? null,
          unproven: false,
          manualPending: true,
          reasoning: null,
        })),
    ]),
    acceptanceFailures,
    artifacts: {
      report: path.join(runDir, "report.json"),
      html: path.join(runDir, "report.html"),
    },
  };
}
