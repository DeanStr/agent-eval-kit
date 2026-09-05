import { requiredJudgeResult, aggregateCaseVerdicts, assertJudgementIdentities } from "../judging/contracts.js";
import { assertScreenshotAccess } from "../evidence/inspection.js";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { runProvider } from "../providers/index.js";
import { EVIDENCE_TOOL_NAMES, evidenceMcpLaunch, writeMcpConfig } from "../mcp-config.js";
import { sha256, writeJson } from "../io.js";
import { caseJudgeRequests } from "../judging/evidence.js";
import type { Defect, EvalConfig, EvalSpec, JudgedCase, JudgedItem, ProviderInvocation, RubricItem, ScenarioEvidence, Verdict } from "../types.js";
import { pairResultSchema, type PairResult, type VoteSummary } from "./contracts.js";
import { compareImages, inspectImage, normalizeImage, statisticChanges } from "./images.js";
import { visualEvidenceReader } from "./inputs.js";
import { evaluateStatistics, type StatisticSample } from "./statistics.js";
import { decideVotes, journalVote, mapConcurrent, pairwiseVoteVerdict } from "./votes.js";
import { comparisonHtml } from "./report.js";

export function pairOutcome(result: PairResult, candidateIsA: boolean, minimumConfidence: number): string {
  if (result.preferred === "abstain" || result.confidence < minimumConfidence) return "abstain";
  if (result.preferred === "equivalent") return "equivalent";
  return result.preferred === (candidateIsA ? "A" : "B") ? "win" : "loss";
}
export function assertPairInspection(directory: string, preferred: PairResult["preferred"]): void {
  assertScreenshotAccess({ directory, access: "mcp", selectedRefs: ["A", "B"],
    requiredRefs: preferred === "abstain" ? [] : ["A", "B"], context: "Pairwise judge" });
}

async function invokePair(config: EvalConfig, item: RubricItem, directory: string, a: Buffer, b: Buffer): Promise<PairResult> {
  const attachmentRoot = path.join(directory, "attachments"); fs.mkdirSync(attachmentRoot);
  const images = ["A", "B"].map(label => path.join(attachmentRoot, `${label}.png`));
  fs.writeFileSync(images[0], a); fs.writeFileSync(images[1], b);
  const promptFile = path.join(directory, "prompt.md"), schemaFile = path.join(directory, "schema.json");
  const prompt = [
    "PAIRWISE_EVALUATION: Compare only the supplied anonymous images A and B. Do not infer which is the candidate or baseline.",
    "Use the criterion and pass criteria as the quality dimensions. Evaluate visible quality, not resemblance, brand recognition, or speculative implementation details.",
    "Choose A or B if one is better; equivalent requires positive evidence of equivalence. Use abstain when evidence is insufficient. Confidence is a diagnostic self-assessment, not a calibrated probability.",
    "Findings must identify the image and a normalized bounding region within it. Only report visible defects. Do not use tools except the supplied evidence screenshot viewer.",
    config.judge.provider === "codex" ? "Images are attached in A, B order." : "View both images using view_screenshot with refs A and B before deciding.",
    `CRITERION: ${item.criterion}\nPASS CRITERIA: ${item.passCriteria}`,
    config.instructions ? `EVALUATOR INSTRUCTIONS:\n${config.instructions}` : "",
  ].join("\n\n");
  fs.writeFileSync(promptFile, prompt); writeJson(schemaFile, z.toJSONSchema(pairResultSchema));
  let mcp: ProviderInvocation["mcp"];
  if (config.judge.provider !== "codex" && config.judge.provider !== "mock") {
    const contextFile = path.join(directory, "evidence-context.json");
    writeJson(contextFile, { attachmentRoot, screenshots: { A: "A.png", B: "B.png" }, transcriptFile: path.join(directory, "evidence-transcript.ndjson"), maxToolCalls: 4 });
    const launch = evidenceMcpLaunch(contextFile);
    mcp = { name: "evidence", ...launch, configFile: writeMcpConfig(directory, "evidence", launch.command, launch.args), toolNames: EVIDENCE_TOOL_NAMES };
  }
  const result = await runProvider(config.judge.provider, {
    purpose: "judge", cwd: directory, promptFile, outputFile: path.join(directory, "provider-final.json"), outputSchemaFile: schemaFile,
    eventLogFile: path.join(directory, "provider-events.ndjson"), stderrFile: path.join(directory, "provider-stderr.log"),
    model: config.judge.model, effort: config.judge.effort, maxTurns: config.judge.maxTurns, timeoutSeconds: config.judge.timeoutSeconds,
    extraArgs: config.judge.extraArgs, images: config.judge.provider === "codex" ? images : [], additionalDirs: [], allowWorkspaceTools: false, mcp,
  });
  writeJson(path.join(directory, "provider-run.json"), result);
  if (result.timedOut || result.exitCode !== 0 || result.policyViolations?.length) throw new Error(`Pairwise judge execution failed; see ${directory}`);
  const validated = pairResultSchema.safeParse(result.structured);
  if (!validated.success) throw new Error(`Pairwise judge returned invalid structured output; see ${directory}. ${validated.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const parsed = validated.data;
  if (mcp) assertPairInspection(directory, parsed.preferred);
  return parsed;
}

const storedVoteSchema = z.object({ candidateIsA: z.boolean(), raw: pairResultSchema }).strict();
export async function judgePairwise(options: {
  config: EvalConfig; spec: EvalSpec; evidence: ScenarioEvidence[]; runDir: string; areaDirectory: string;
  onVoteComplete?: () => void; onProgress?: (message: string) => void;
}): Promise<{ items: JudgedItem[]; cases: JudgedCase[]; defects: Defect[] }> {
  const { config, spec, evidence, runDir } = options;
  if (!spec.rubric.some(item => item.grader.type === "pairwise")) return { items: [], cases: [], defects: [] };
  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  const reader = visualEvidenceReader(runDir);
  const results = await mapConcurrent(spec.rubric.filter(item => item.grader.type === "pairwise"), config.judge.concurrency ?? 1, async item => {
    if (item.grader.type !== "pairwise") throw new Error("Expected pairwise grader");
    const grader = item.grader, defects: Defect[] = [], comparisons: string[] = [];
    const statisticSamples = new Map<string, StatisticSample>(item.scenarios.flatMap(id => grader.references.map((_ref, index) => [`${id}/${index}`, { id: `${id}/${index}`, unavailable: "Candidate evidence unavailable" }] as const)));
    const scenarioResults: Array<{ id: string; verdict: Verdict; refs: string[]; votes: VoteSummary[] }> = [];
    for (const scenarioId of item.scenarios) {
      const scenario = evidence.find(value => value.scenarioId === scenarioId);
      if (!scenario || scenario.outcome !== "completed") { scenarioResults.push({ id: scenarioId, verdict: "cannot_judge", refs: [], votes: [] }); continue; }
      const candidateInput = reader.candidate(scenario, grader.candidate);
      if (!candidateInput) { scenarioResults.push({ id: scenarioId, verdict: "cannot_judge", refs: [], votes: [] }); continue; }
      const { ref: candidateRef, bytes: candidateBytes } = candidateInput;
      const summaries: VoteSummary[] = [];
      for (const [index, reference] of grader.references.entries()) {
        const key = `${item.id}/${scenarioId}/${index}`;
        const { bytes: referenceBytes } = reader.reference(key);
        const [candidate, comparator] = await Promise.all([
          normalizeImage(candidateBytes, grader.panel, reference.candidateCrop), normalizeImage(referenceBytes, grader.panel, reference.crop),
        ]);
        const directory = path.join(options.areaDirectory, "pairwise", item.id, scenarioId, String(index + 1));
        fs.mkdirSync(directory, { recursive: true });
        const candidatePanel = path.join(directory, "candidate.png"), referencePanel = path.join(directory, "reference.png");
        fs.writeFileSync(candidatePanel, candidate); fs.writeFileSync(referencePanel, comparator);
        const diff = await compareImages(candidatePanel, referencePanel);
        fs.writeFileSync(path.join(directory, "difference.png"), diff.difference);
        const [candidateStats, referenceStats] = await Promise.all([inspectImage(candidateBytes, { crop: reference.candidateCrop }), inspectImage(referenceBytes, { crop: reference.crop })]);
        statisticSamples.set(`${scenarioId}/${index}`, { id: `${scenarioId}/${index}`, before: referenceStats, after: candidateStats });
        writeJson(path.join(directory, "diagnostics.json"), { candidate: candidateStats, reference: referenceStats, changes: statisticChanges(referenceStats, candidateStats), normalizedPanelDifference: { changedPixelRatio: diff.changedPixelRatio, meanAbsoluteChannelDelta: diff.meanAbsoluteChannelDelta }, note: "Image statistics use cropped source pixels without panel padding/resizing. They are diagnostic, not quality scores. Near-zero relative denominators are unavailable." });
        const votes: Array<z.infer<typeof storedVoteSchema>> = [];
        const accept = grader.policy === "non_regression" ? ["win", "equivalent"] : ["win"];
        let decision = decideVotes([], grader.voting, accept);
        while (decision.decision === "continue") {
          const ordinal = votes.length + 1;
          options.onProgress?.(`pairwise ${item.id}/${scenarioId} reference ${index + 1} vote ${ordinal}`);
          const vote = await journalVote({
            directory: path.join(directory, `vote-${String(ordinal).padStart(2, "0")}`),
            identity: { evaluator: receipt.evaluationFingerprint, candidate: sha256(candidate), reference: sha256(comparator), grader, criterion: item.criterion, passCriteria: item.passCriteria, ordinal, judge: config.judge },
            validate: value => storedVoteSchema.parse(value), seal: options.onVoteComplete,
            run: async voteDir => {
              const candidateIsA = randomInt(2) === 0;
              return { candidateIsA, raw: await invokePair(config, item, voteDir, candidateIsA ? candidate : comparator, candidateIsA ? comparator : candidate) };
            },
          });
          votes.push(vote);
          decision = decideVotes(votes.map(v => pairOutcome(v.raw, v.candidateIsA, grader.voting.minimumConfidence)), grader.voting, accept);
        }
        summaries.push(decision);
        comparisons.push(path.relative(runDir, path.join(directory, "comparison.html")).split(path.sep).join("/"));
        const findings = votes.flatMap(vote => pairOutcome(vote.raw, vote.candidateIsA, grader.voting.minimumConfidence) === "abstain" ? [] : vote.raw.findings.filter(finding => finding.image === (vote.candidateIsA ? "A" : "B")));
        for (const finding of findings) defects.push({ severity: finding.severity, description: finding.description, evidenceRefs: [path.relative(runDir, candidatePanel).split(path.sep).join("/")], region: finding.region });
        writeJson(path.join(directory, "comparison.json"), { decision, votes, candidateRef, referenceKey: key, findings });
        fs.writeFileSync(path.join(directory, "comparison.html"), comparisonHtml({
          id: item.id, policy: grader.policy, decision, findings,
          votes: votes.map(vote => ({ outcome: pairOutcome(vote.raw, vote.candidateIsA, grader.voting.minimumConfidence), reasoning: vote.raw.reasoning })),
        }));
      }
      scenarioResults.push({ id: scenarioId, verdict: aggregateCaseVerdicts(summaries.map(s => pairwiseVoteVerdict(s.decision, grader.policy))), refs: [candidateRef], votes: summaries });
    }
    const verdict = aggregateCaseVerdicts(scenarioResults.map(result => result.verdict));
    const { verdict: _diagnosticVerdict, ...statistics } = evaluateStatistics([...statisticSamples.values()]);
    writeJson(path.join(options.areaDirectory, "pairwise", item.id, "statistics.json"), statistics);
    const counts: Record<string, number> = {};
    for (const summary of scenarioResults.flatMap(r => r.votes)) for (const [key, count] of Object.entries(summary.counts)) counts[key] = (counts[key] ?? 0) + count;
    const summaries = scenarioResults.flatMap(r => r.votes);
    const judged: JudgedItem = { id: item.id, comparisons, source: "pairwise", verdict, confidence: verdict === "cannot_judge" ? "low" : "high", reasoning: `Blind ${grader.policy} comparisons: ${scenarioResults.map(r => `${r.id}=${r.verdict}`).join(", ")}. Every reference must pass.`, evidenceRefs: scenarioResults.flatMap(r => r.refs), votes: { attempted: summaries.reduce((n, s) => n + s.attempted, 0), judgeable: summaries.reduce((n, s) => n + s.judgeable, 0), counts, decision: verdict } };
    const cases: JudgedCase[] = caseJudgeRequests([item], evidence).map(request => ({
      ...request, areaId: spec.id, source: "pairwise",
      verdict: aggregateCaseVerdicts(request.scenarioIds.map(id => requiredJudgeResult(
        scenarioResults.find(r => r.id === id),
        `pairwise scenario ${id} for case ${request.rubricId}/${request.caseId} in ${options.areaDirectory}`,
      ).verdict)),
      confidence: judged.confidence, reasoning: judged.reasoning,
      evidenceRefs: scenarioResults.filter(r => request.scenarioIds.includes(r.id)).flatMap(r => r.refs),
    }));
    assertJudgementIdentities({ items: [judged], cases }, { items: [item], cases: caseJudgeRequests([item], evidence) }, options.areaDirectory);
    return { item: judged, cases, defects };
  });
  return { items: results.map(r => r.item), cases: results.flatMap(r => r.cases), defects: results.flatMap(r => r.defects) };
}
