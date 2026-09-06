import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNdjson, stableJson, writeJson } from "./io.js";
import type {
  CheckpointEvidence,
  RubricItem,
  Scenario,
  ScenarioEvidence,
  TranscriptEntry,
} from "./types.js";

export const checkpointEvidenceSchema = z
  .object({
    step: z.number().int().positive(),
    evidenceRefs: z
      .array(z.string().regex(/^step:[1-9][0-9]*$/))
      .min(1)
      .max(20),
  })
  .strict();
const checkpointInputSchema = z
  .object({
    name: z.string(),
    evidenceRefs: checkpointEvidenceSchema.shape.evidenceRefs,
  })
  .strict();

export function requiredCheckpointNames(rubric: RubricItem[], scenarioId: string): string[] {
  return [...new Set(rubric.flatMap((item) => selectedCheckpoints(item, scenarioId) ?? []))];
}

export function checkpointCompletionError(
  required: string[] | undefined,
  directory: string,
  outcome: string,
): string | undefined {
  if (outcome !== "completed" || !required?.length) return undefined;
  const file = path.join(directory, "checkpoints.json");
  const recorded = fs.existsSync(file)
    ? z
        .record(z.string(), checkpointEvidenceSchema)
        .parse(JSON.parse(fs.readFileSync(file, "utf8")))
    : {};
  const missing = required.filter((name) => !Object.hasOwn(recorded, name));
  if (!missing.length) return undefined;
  return `ERROR: Cannot finalize completed: missing rubric-required checkpoints: ${missing.join(", ")}. Record each with 1–20 unique successful earlier evidence steps and verify the call succeeds, then retry done. If the workflow could not be exercised, finish with an honest blocked or feature_not_found outcome and explain the unavailable evidence. Missing checkpoints remain unavailable coverage.`;
}
const evidenceAction = (entry: TranscriptEntry) =>
  !entry.isError &&
  !["observe", "done", "publish_output", "checkpoint", "switch_persona"].includes(entry.tool);

export function validateCheckpoints(
  scenario: Pick<Scenario, "checkpoints">,
  raw: unknown,
  transcript: TranscriptEntry[],
  sealed = true,
): Record<string, CheckpointEvidence> {
  const checkpoints = z.record(z.string(), checkpointEvidenceSchema).parse(raw);
  for (const entry of transcript.filter((entry) => entry.tool === "checkpoint" && !entry.isError)) {
    const name = entry.input.name;
    if (
      typeof name !== "string" ||
      !Object.hasOwn(checkpoints, name) ||
      checkpoints[name]!.step !== entry.step
    )
      throw new Error(
        `Successful checkpoint at step ${entry.step} is missing its matching metadata`,
      );
  }
  for (const [name, checkpoint] of Object.entries(checkpoints)) {
    if (!Object.hasOwn(scenario.checkpoints ?? {}, name))
      throw new Error(`Undeclared checkpoint ${name}`);
    const available = new Set(
      transcript
        .filter((entry) => evidenceAction(entry) && entry.step < checkpoint.step)
        .map((entry) => `step:${entry.step}`),
    );
    if (
      new Set(checkpoint.evidenceRefs).size !== checkpoint.evidenceRefs.length ||
      checkpoint.evidenceRefs.some((ref) => !available.has(ref))
    )
      throw new Error(`Checkpoint ${name} must cite unique successful earlier evidence steps`);
    if (
      sealed &&
      !transcript.some(
        (entry) =>
          entry.step === checkpoint.step &&
          entry.tool === "checkpoint" &&
          !entry.isError &&
          entry.input.name === name &&
          stableJson(entry.input.evidenceRefs) === stableJson(checkpoint.evidenceRefs),
      )
    )
      throw new Error(`Checkpoint ${name} has no successful publication in its transcript`);
  }
  return checkpoints;
}

export function registerCheckpointTool(
  server: McpServer,
  options: {
    checkpoints: Scenario["checkpoints"];
    directory: string;
    transcriptFile: string;
    call: (
      input: Record<string, unknown>,
      action: () => string,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
  },
): void {
  server.registerTool(
    "checkpoint",
    {
      description: `Record that a declared check was exercised, without grading it. name must be a declared checkpoint string; evidenceRefs must contain 1–20 unique successful earlier steps as step:N. Record immediately after gathering evidence and check the call succeeds; correct rejected calls before done. Declared checks: ${JSON.stringify(options.checkpoints ?? {})}`,
      // Validate inside the recorded call. SDK-level rejection would omit the
      // failed attempt from the authoritative transcript and its step sequence.
      inputSchema: z.looseObject({
        name: z.unknown().optional().describe("Required: declared checkpoint name (string)"),
        evidenceRefs: z
          .unknown()
          .optional()
          .describe("Required: array of 1–20 unique step:N strings"),
      }),
    },
    (input) =>
      options.call(input, () => {
        const { name, evidenceRefs } = checkpointInputSchema.parse(input);
        const file = path.join(options.directory, "checkpoints.json");
        const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
        if (Object.hasOwn(prior, name))
          throw new Error(`Checkpoint ${name} already recorded; checkpoints are immutable`);
        const transcript = readNdjson<TranscriptEntry>(options.transcriptFile);
        const step = Math.max(0, ...transcript.map((entry) => entry.step)) + 1;
        const result = validateCheckpoints(
          { ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}) },
          { ...prior, [name]: { step, evidenceRefs } },
          transcript,
          false,
        );
        writeJson(file, result);
        return `Checkpoint ${name} recorded. The judge will assess its evidence; completion is not a pass.`;
      }),
  );
}

export function rubricWasReached(rubric: RubricItem, evidence: ScenarioEvidence[]): boolean {
  const relevant = evidence.filter(
    (s) => !rubric.scenarios.length || rubric.scenarios.includes(s.scenarioId),
  );
  for (const id of Object.keys(rubric.checkpoints ?? {}))
    if (!relevant.some((scenario) => scenario.scenarioId === id)) return false;
  let reached = false;
  for (const scenario of relevant) {
    const names = selectedCheckpoints(rubric, scenario.scenarioId);
    if (names) {
      if (
        scenario.outcome === "agent_error" ||
        names.some((name) => !Object.hasOwn(scenario.checkpoints ?? {}, name))
      )
        return false;
      reached = true;
    } else if (scenario.outcome === "completed" || scenario.outcome === "feature_not_found")
      reached = true;
  }
  return reached;
}

export function selectedCheckpoints(rubric: RubricItem, scenarioId: string): string[] | undefined {
  return Object.hasOwn(rubric.checkpoints ?? {}, scenarioId)
    ? rubric.checkpoints![scenarioId]
    : undefined;
}

/** Checkpoint-scoped claims can cite only the exercised steps and their images/files. */
export function checkpointRefs(scenario: ScenarioEvidence, names: string[]): string[] {
  const refs: string[] = [];
  for (const name of names) {
    const checkpoint = Object.hasOwn(scenario.checkpoints ?? {}, name)
      ? scenario.checkpoints![name]
      : undefined;
    if (!checkpoint || scenario.outcome === "agent_error") continue;
    refs.push(`${scenario.scenarioId}/evidence.json#checkpoint-${name}`);
    for (const ref of checkpoint.evidenceRefs) {
      const step = Number(ref.slice(5));
      refs.push(`${scenario.scenarioId}/${scenario.kind}-transcript.ndjson#step-${step}`);
      refs.push(
        ...scenario.screenshots
          .filter((shot) => shot.step === step)
          .map((shot) => `${scenario.scenarioId}/${shot.path}`),
      );
      refs.push(
        ...(scenario.files ?? [])
          .filter((file) => file.step === step)
          .map((file) => `${scenario.scenarioId}/${file.path}`),
      );
    }
  }
  return refs;
}
