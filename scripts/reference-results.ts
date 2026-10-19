import type { RunReport } from "../src/types.js";
import { verdictOutcome } from "../src/validation-metrics.js";

export function referenceOutcomes(report: RunReport | undefined, smoke: boolean) {
  if (!report) throw new Error("Reference evaluation completed without a report");
  const area = report.areas.find((item) => item.id === "reference");
  if (!area) throw new Error("Reference report is missing area reference");
  return (smoke ? ["TOTAL", "PERSIST"] : ["TOTAL"]).map((id) => {
    const items = area.items.filter((item) => item.id === id);
    if (items.length !== 1) throw new Error(`Reference report requires exactly one ${id} verdict`);
    const item = items[0]!;
    if (id === "PERSIST" && item.verdict !== "cannot_judge") {
      const scenario = area.scenarios.find((item) => item.scenarioId === "PROFILE");
      if (!scenario?.screenshots.length)
        throw new Error("Reference PERSIST verdict lacks required browser screenshot evidence");
    }
    return verdictOutcome(item.verdict);
  });
}
