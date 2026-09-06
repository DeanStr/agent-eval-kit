import { z } from "zod";
import { httpUrlSchema } from "./config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { readNdjson, writeJson } from "./io.js";
import type { BoundInput, EvalSpec, Scenario, ScenarioEvidence, ScenarioOutput, TranscriptEntry } from "./types.js";

const outputSchema = z.object({
  value: z.union([z.string().min(1).max(4000), z.number().finite(), z.boolean()]),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(20),
}).strict();

export function validateOutputs(scenario: Pick<Scenario, "outputs">, raw: unknown, transcript: TranscriptEntry[]): Record<string, ScenarioOutput> {
  const outputs = z.record(z.string(), outputSchema).parse(raw);
  const refs = new Set(transcript.filter(entry => !entry.isError && !["observe", "publish_output", "done", "switch_persona"].includes(entry.tool)).map(entry => `step:${entry.step}`));
  for (const [name, output] of Object.entries(outputs)) {
    const declaration = scenario.outputs && Object.hasOwn(scenario.outputs, name) ? scenario.outputs[name] : undefined;
    if (!declaration) throw new Error(`Undeclared scenario output ${name}`);
    const type = declaration.type;
    if (typeof output.value !== (type === "url" ? "string" : type)) throw new Error(`Output ${name} must have type ${type}`);
    if (type === "url" && !httpUrlSchema.safeParse(output.value).success) {
      throw new Error(`Output ${name} must be an absolute HTTP(S) URL without credentials or access tokens; use saved personas`);
    }
    for (const ref of output.evidenceRefs) if (!refs.has(ref)) throw new Error(`Output ${name} cites unavailable evidence ${ref}; cite a successful earlier tool step as step:N`);
  }
  return outputs;
}

/** Sealed evidence with an incomplete workflow contract is invalid, not a legacy format to upgrade. */
export function assertSavedWorkflowEvidence(scenario: Scenario, evidence: ScenarioEvidence): void {
  const fail = (detail: string): never => { throw new Error(`Invalid saved workflow evidence for ${scenario.id}: ${detail}. Start a new run.`); };
  if (scenario.dependsOn.length) {
    const hashes = evidence.dependencyEvidence;
    if (!hashes || Object.keys(hashes).length !== new Set(scenario.dependsOn).size ||
        scenario.dependsOn.some(id => !Object.hasOwn(hashes, id) || typeof hashes[id] !== "string" || !/^[a-f0-9]{64}$/.test(hashes[id]))) {
      fail("missing or invalid prerequisite hashes");
    }
  }
  if (evidence.outcome === "completed" || evidence.outcome === "feature_not_found") {
    for (const name of Object.keys(scenario.inputs ?? {})) {
      if (!evidence.inputs || !Object.hasOwn(evidence.inputs, name)) fail(`missing bound input ${name}`);
    }
  }
  if (evidence.outcome === "completed") {
    for (const name of Object.keys(scenario.outputs ?? {})) {
      if (!evidence.outputs || !Object.hasOwn(evidence.outputs, name)) fail(`completed scenario is missing required output ${name}`);
    }
  }
  validateOutputs(scenario, evidence.outputs ?? {}, evidence.transcript);
}

/** Explicit bindings carry source provenance, never a shared mutable variable bag. */
export function bindInputs(scenario: Scenario, evidence: Map<string, Pick<ScenarioEvidence, "outcome" | "outputs">>): Record<string, BoundInput> {
  return Object.fromEntries(Object.entries(scenario.inputs ?? {}).map(([name, binding]) => {
    const source = evidence.get(binding.from);
    if (!source || source.outcome !== "completed") throw new Error(`Input ${name}: dependency ${binding.from} did not complete`);
    const output = source.outputs && Object.hasOwn(source.outputs, binding.output) ? source.outputs[binding.output] : undefined;
    if (!output) throw new Error(`Input ${name}: output ${binding.from}.${binding.output} is unavailable`);
    return [name, { ...output, scenarioId: binding.from, output: binding.output }];
  }));
}

/** Missing selected areas are a planning error; excluded scenarios remain blocked evidence. */
export function validateWorkflowSelection(specs: EvalSpec[]): void {
  const scenarios = new Map(specs.flatMap(spec => spec.scenarios.map(scenario => [scenario.id, scenario] as const)));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Scenario dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    const scenario = scenarios.get(id);
    if (!scenario) throw new Error(`Required scenario ${id} is outside the selected areas/split. Include its prerequisite area and matching split.`);
    visiting.add(id);
    for (const dependency of scenario.dependsOn) visit(dependency);
    for (const [name, binding] of Object.entries(scenario.inputs ?? {})) {
      if (!scenario.dependsOn.includes(binding.from)) throw new Error(`${id}.inputs.${name}: ${binding.from} must be declared in dependsOn`);
      if (!Object.hasOwn(scenarios.get(binding.from)?.outputs ?? {}, binding.output)) throw new Error(`${id}.inputs.${name}: unknown output ${binding.from}.${binding.output}`);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of scenarios.keys()) visit(id);
}

export function registerOutputTool(server: McpServer, options: {
  outputs?: Scenario["outputs"];
  directory: string;
  transcriptFile: string;
  call: (input: Record<string, unknown>, action: () => string) => Promise<{
    content: Array<{ type: "text"; text: string }>; isError?: boolean;
  }>;
}): void {
  server.registerTool("publish_output", {
    description: `Publish an observed declared output with provenance. Cite successful earlier tool steps as step:N. Never publish passwords or capability links. Declared outputs: ${JSON.stringify(options.outputs ?? {})}`,
    inputSchema: { name: z.string(), value: outputSchema.shape.value, evidenceRefs: outputSchema.shape.evidenceRefs },
  }, ({ name, value, evidenceRefs }) => options.call({ name, value, evidenceRefs }, () => {
    const file = path.join(options.directory, "outputs.json");
    const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const outputs = validateOutputs({ outputs: options.outputs }, { ...prior, [name]: { value, evidenceRefs } }, readNdjson<TranscriptEntry>(options.transcriptFile));
    writeJson(file, outputs);
    return `Output ${name} recorded with evidence provenance.`;
  }));
}
