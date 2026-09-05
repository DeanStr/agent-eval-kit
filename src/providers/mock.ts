import fs from "node:fs";
import type { ProviderInvocation, ProviderResult } from "../types.js";

export async function runMock(invocation: ProviderInvocation): Promise<ProviderResult> {
  const prompt = fs.readFileSync(invocation.promptFile, "utf8");
  const scenarioId = /SCENARIO_ID:\s*([^\n]+)/.exec(prompt)?.[1]?.trim() ?? "mock";
  const jsonBlock = (label: string, next: string): unknown[] => {
    const match = new RegExp(`${label}:\\n([\\s\\S]*?)\\n\\n${next}:`).exec(prompt);
    if (!match) return [];
    try {
      const value = JSON.parse(match[1]);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const rubric = jsonBlock("RUBRIC_JSON", "CASE_REQUESTS_JSON") as Array<{ id?: string }>;
  const cases = jsonBlock("CASE_REQUESTS_JSON", "EVIDENCE_JSON") as Array<{ rubricId?: string; caseId?: string }>;
  const structured = invocation.purpose === "scenario"
    ? {
        outcome: "completed",
        summary: `Offline mock completed ${scenarioId}.`,
        observations: ["Mock provider: no agent actions were executed."],
        evidenceRefs: [],
      }
    : prompt.startsWith("PAIRWISE_EVALUATION:") ? { preferred: "abstain", confidence: 0, reasoning: "Offline mock judge does not inspect images.", findings: [] } : {
        items: rubric.flatMap((item) => item.id ? [{
          id: item.id,
          verdict: "cannot_judge",
          confidence: "low",
          reasoning: "Offline mock judge does not inspect evidence.",
          evidenceRefs: [],
        }] : []),
        cases: cases.flatMap((item) => item.rubricId && item.caseId ? [{
          rubricId: item.rubricId,
          caseId: item.caseId,
          verdict: "cannot_judge",
          confidence: "low",
          reasoning: "Offline mock judge does not inspect evidence.",
          evidenceRefs: [],
        }] : []),
        defects: [],
        notes: "Offline mock judge.",
      };
  const finalText = JSON.stringify(structured);
  fs.writeFileSync(invocation.outputFile, finalText);
  fs.writeFileSync(invocation.eventLogFile, JSON.stringify({ type: "mock.completed", structured }) + "\n");
  fs.writeFileSync(invocation.stderrFile, "");
  return {
    provider: "mock",
    exitCode: 0,
    signal: null,
    timedOut: false,
    finalText,
    structured,
    sessionId: "mock-session",
    usage: { input_tokens: 0, output_tokens: 0 },
    command: ["mock"],
  };
}
