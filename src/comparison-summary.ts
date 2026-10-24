import { comparisonVerdict, type ComparisonReport, type ItemChange } from "./compare.js";
import type { SummaryLine } from "./run-summary.js";
import { oneLine, type Tone } from "./terminal.js";

const changeDisplay: Record<Exclude<ItemChange, "unchanged">, { symbol: string; tone: Tone }> = {
  regressed: { symbol: "✗", tone: "fail" },
  lost_coverage: { symbol: "!", tone: "warn" },
  removed: { symbol: "−", tone: "warn" },
  improved: { symbol: "✓", tone: "pass" },
  gained_coverage: { symbol: "+", tone: "info" },
  added: { symbol: "+", tone: "info" },
  changed: { symbol: "~", tone: "warn" },
  unavailable: { symbol: "?", tone: "muted" },
};

const order: ItemChange[] = [
  "regressed",
  "lost_coverage",
  "removed",
  "changed",
  "improved",
  "gained_coverage",
  "added",
  "unavailable",
];

/** A one-line verdict, then each criterion that changed, worst first. */
export function comparisonLines(comparison: ComparisonReport): SummaryLine[] {
  const changed = comparison.items
    .filter((item) => item.change !== "unchanged")
    .sort((left, right) => order.indexOf(left.change) - order.indexOf(right.change));
  const verdict = comparisonVerdict(comparison);
  const tone = { good: "pass", bad: "fail", neutral: "muted" } as const;
  const width = Math.min(
    32,
    Math.max(0, ...changed.map((item) => `${item.areaId}/${item.id}`.length)),
  );
  return [
    { text: verdict.text, tone: tone[verdict.tone] },
    ...changed.map((item) => {
      const display = changeDisplay[item.change as Exclude<ItemChange, "unchanged">];
      const verdicts =
        item.baselineVerdict || item.candidateVerdict
          ? `${item.baselineVerdict ?? "—"} → ${item.candidateVerdict ?? "—"}`
          : item.change.replace("_", " ");
      const reasoning = item.candidate?.reasoning ?? item.baseline?.reasoning;
      return {
        text: `  ${display.symbol} ${`${item.areaId}/${item.id}`.padEnd(width)} ${verdicts}${reasoning ? `  ${oneLine(reasoning, 90)}` : ""}`,
        tone: display.tone,
      };
    }),
  ];
}
