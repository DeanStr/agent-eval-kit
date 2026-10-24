import { shellArg } from "./cli-recovery.js";
import { displayPath, formatPct, plural } from "./format.js";

export { displayPath };
import { oneLine, type Tone } from "./terminal.js";
import type { AreaResult, RunReport, Verdict } from "./types.js";

export interface SummaryLine {
  text: string;
  tone?: Tone;
}

const verdictDisplay: Record<Verdict, { symbol: string; tone: Tone; label: string }> = {
  pass: { symbol: "✓", tone: "pass", label: "pass" },
  partial: { symbol: "◐", tone: "warn", label: "partial" },
  fail: { symbol: "✗", tone: "fail", label: "fail" },
  not_found: { symbol: "✗", tone: "fail", label: "not found" },
  cannot_judge: { symbol: "?", tone: "warn", label: "cannot judge" },
};

/** One line per rubric item, in rubric order, so a run explains itself without opening the report. */
export function criterionLines(area: AreaResult, rubricOrder: string[]): SummaryLine[] {
  const ids = [
    ...new Set([...rubricOrder, ...area.items.map((item) => item.id), ...area.pendingManual]),
  ];
  const width = Math.min(24, Math.max(...ids.map((id) => id.length)));
  return ids.flatMap((id): SummaryLine[] => {
    const item = area.items.find((candidate) => candidate.id === id);
    const gate = area.gates.find((candidate) => candidate.itemId === id) ? " · gate" : "";
    const label = id.padEnd(width);
    if (area.unproven.includes(id))
      return [
        {
          text: `? ${label} unproven${gate}  automatic verdict discarded: no backing scenario was reached`,
          tone: "warn",
        },
      ];
    if (!item || item.verdict === "cannot_judge") {
      if (area.pendingManual.includes(id))
        return [{ text: `○ ${label} pending manual review${gate}`, tone: "muted" }];
      if (!item) return [];
    }
    const display = verdictDisplay[item.verdict];
    const pendingShare = area.pendingManual.includes(id) ? " (manual share pending)" : "";
    const reasoning = item.reasoning ? `  ${oneLine(item.reasoning)}` : "";
    return [
      {
        text: `${display.symbol} ${label} ${display.label}${gate}${pendingShare}${reasoning}`,
        tone: display.tone,
      },
    ];
  });
}

export function headline(report: RunReport): SummaryLine {
  const parts = [
    report.scoreWithheld
      ? `score withheld (provisional ${formatPct(report.overallScorePct)})`
      : `${formatPct(report.overallScorePct)} score`,
    `${formatPct(report.overallCoveragePct)} coverage`,
  ];
  const gateCount = report.areas.reduce((sum, area) => sum + area.gates.length, 0);
  if (!report.gates.passed)
    parts.push(
      `${plural(report.gates.blocking.length, "critical gate")} not satisfied (${report.gates.blocking.map((gate) => gate.itemId).join(", ")})`,
    );
  else if (gateCount) parts.push(`${plural(gateCount, "critical gate")} passed`);
  if (report.manualPending) parts.push(`${plural(report.manualPending, "manual review")} pending`);
  return {
    text: parts.join(" · "),
    tone: !report.gates.passed ? "fail" : report.scoreWithheld ? "warn" : "pass",
  };
}

/** Commands worth running next, already filled in with this run's paths. */
export function nextSteps(
  runDir: string,
  report: RunReport,
  previousRunDir: string | undefined,
): string[] {
  const steps: string[] = [];
  const run = shellArg(displayPath(runDir));
  if (report.manualPending)
    steps.push(
      `aek finalize --run ${run} --interactive   # record ${plural(report.manualPending, "manual verdict")}`,
    );
  if (previousRunDir)
    steps.push(
      `aek compare --baseline ${shellArg(displayPath(previousRunDir))} --candidate ${run}`,
    );
  return steps;
}
