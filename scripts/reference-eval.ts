import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { withCliSignals, throwIfCancelled } from "../src/cancellation.js";
import { loadConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { assertArtifactIntegrity } from "../src/integrity.js";
import { createTimestampedDirectory, writeJson } from "../src/io.js";
import { runEvaluation } from "../src/runner.js";
import { loadSpecs } from "../src/specs.js";
import type { ProviderId, Verdict } from "../src/types.js";

const fixtures = path.join(import.meta.dirname, "fixtures/reference");
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, "expected.json"), "utf8")) as {
  contract: string;
  variants: Array<{ file: string; expected: Verdict; reason: string }>;
};
const { values } = parseArgs({ options: {
  provider: { type: "string" }, judge: { type: "string" },
  smoke: { type: "boolean", default: false },
  repetitions: { type: "string", default: "1" },
  output: { type: "string" }, help: { type: "boolean" },
} });
const realProvider = (value: string): ProviderId => {
  if (!["codex", "claude", "grok"].includes(value)) throw new Error("Provider must be codex, claude, or grok");
  return value as ProviderId;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function main(): Promise<void> {
  if (values.help) {
    console.log("Reference evaluation: [--provider codex|claude|grok] [--judge provider] [--repetitions N] [--smoke] [--output NEW_DIRECTORY]\nWithout --provider, runs deterministic reference checks without model quota. --smoke requires --provider and checks workspace and browser evidence on the working fixture.");
    return;
  }
  if ((values.smoke || values.judge) && !values.provider) throw new Error("--smoke and --judge require --provider");
  const agent = values.provider ? realProvider(values.provider) : "mock";
  const judge = values.judge ? realProvider(values.judge) : agent;
  const repetitions = Number(values.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("--repetitions must be 1–20");
  const checks = doctor({ providers: [...new Set([agent, judge])], requireBrowser: values.smoke });
  const unavailable = checks.filter(check => check.required && !check.ok);
  if (unavailable.length) throw new Error(unavailable.map(check => `${check.name}: ${check.detail}`).join("\n"));
  const output = values.output ? path.resolve(values.output) : createTimestampedDirectory(path.resolve(".agent-eval/reference"));
  if (values.output) fs.mkdirSync(output, { recursive: false });
  console.log(`Reference artifacts: ${output}`);
  writeJson(path.join(output, "environment.json"), { node: process.version, platform: process.platform, checks });
  const observations: Array<{ variant: string; repetition: number; expected: Verdict; actual: Verdict; runDir?: string; error?: string }> = [];
  const variants = values.smoke ? expected.variants.slice(0, 1) : expected.variants;
  let server: http.Server | undefined;
  let url: string | undefined;
  const summarize = () => {
    const negatives = observations.filter(item => item.expected !== "pass");
    const positives = observations.filter(item => item.expected === "pass");
    const abstentions = observations.filter(item => item.actual === "cannot_judge").length;
    const falseAlarms = positives.filter(item => ["fail", "partial", "not_found"].includes(item.actual)).length;
    const missedDefects = negatives.filter(item => item.actual === "pass").length;
    const correct = observations.filter(item => item.actual === item.expected).length;
    const total = variants.length * repetitions * (values.smoke ? 2 : 1);
    const passed = observations.length === total && !abstentions && !falseAlarms && !missedDefects && !observations.some(item => item.error);
    const summary = {
      schemaVersion: 1, mode: values.smoke ? "provider_smoke" : agent === "mock" ? "deterministic_reference" : "llm_reference",
      agent, judge, plannedObservations: total, observations,
      metrics: { exactMatches: correct, exactMatchRate: observations.length ? correct / observations.length : null,
        falseAlarms, falseAlarmRate: positives.length ? falseAlarms / positives.length : null,
        missedDefects, missedDefectRate: negatives.length ? missedDefects / negatives.length : null,
        abstentions, abstentionRate: observations.length ? abstentions / observations.length : null },
      passed,
      limitations: ["Synthetic reference cases are a regression check, not an estimate of real-world evaluator accuracy.",
        "Expected outcomes are specified in fixtures/reference/expected.json and require maintainer review before use as a calibrated benchmark.",
        "Deterministic mode validates fixtures and harness plumbing; only a real-provider run measures agent/judge behavior."],
    };
    writeJson(path.join(output, "reference-results.json"), summary);
    return summary;
  };
  try {
    if (values.smoke) {
      const html = fs.readFileSync(path.join(fixtures, "form.html"));
      server = http.createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Reference server did not bind");
      url = `http://127.0.0.1:${address.port}`;
    }
    let ordinal = 0;
    for (const variant of variants) for (let repetition = 1; repetition <= repetitions; repetition++) {
      throwIfCancelled();
      // Neutral names and a separate project root keep expectation labels,
      // alternative implementations, and the oracle outside agent inspection.
      const target = path.join(output, `target-${++ordinal}`);
      fs.mkdirSync(target);
      fs.copyFileSync(path.join(fixtures, variant.file), path.join(target, "cart.mjs"));
      const oracleCommand = [process.execPath, path.join(fixtures, "oracle.mjs"), path.join(target, "cart.mjs"), path.join(fixtures, "expected.json")].map(quote).join(" ");
      const spec = {
        id: "reference", title: "Reference application", description: "Cart totals and profile persistence", weight: 100,
        scenarios: [
          { id: "SOURCE", name: "Inspect cart totals", kind: "workspace", instructions: `Inspect cart.mjs through the workspace tools. Explain what its exported functions do and whether they implement this contract: ${expected.contract} Record source-line evidence and concrete example totals.` },
          ...(values.smoke ? [{ id: "PROFILE", name: "Save a display name", kind: "browser", instructions: "Open the app, set Display name to AEK Reference Person, click Save, then navigate to the same URL again to reload. Record whether Saved name: AEK Reference Person remains visible. Capture before and after screenshots." }] : []),
        ],
        rubric: [
          { id: "TOTAL", criterion: `The inspected source implements this contract: ${expected.contract}`, weight: 1, scenarios: ["SOURCE"],
            grader: agent === "mock" ? { type: "command", methodFiles: [path.join(fixtures, "oracle.mjs"), path.join(fixtures, "expected.json")], output: "json", command: oracleCommand } : { type: "llm" },
            passCriteria: "The total export exists and its implementation handles empty carts, quantities greater than one, and multiple line items. This is a source-level criterion: directly inspected code and a complete arithmetic counterexample are sufficient; runtime execution is not required. Missing total is not_found; incorrect arithmetic is fail." },
          ...(values.smoke ? [{ id: "PERSIST", criterion: "The saved display name survives a reload", weight: 1, scenarios: ["PROFILE"], grader: { type: "llm" }, passCriteria: "The supplied before/after screenshot and transcript evidence shows AEK Reference Person saved and still visible after reloading." }] : []),
        ],
      };
      fs.writeFileSync(path.join(target, "spec.yaml"), YAML.stringify(spec));
      const configFile = path.join(target, "evalkit.yaml");
      fs.writeFileSync(configFile, YAML.stringify({
        version: 1, project: { name: "Reference application", root: "." },
        target: url ? { kind: "web", url } : { kind: "repository" },
        agent: { provider: agent, maxTurns: 20, timeoutSeconds: 180 },
        judge: { provider: judge, maxTurns: 20, timeoutSeconds: 180 },
        paths: { specs: "spec.yaml", runs: path.join(output, "runs") },
        scoring: { minimumCoverage: 100 },
      }));
      const config = loadConfig(configFile);
      try {
        const result = await runEvaluation({ config, configFile, specs: loadSpecs(config.paths.specs), fixtures: {} });
        assertArtifactIntegrity(result.runDir, { require: true });
        const items = result.report!.areas[0].items;
        observations.push({ variant: variant.file, repetition, expected: variant.expected, actual: items.find(item => item.id === "TOTAL")?.verdict ?? "cannot_judge", runDir: result.runDir });
        if (values.smoke) {
          const browser = result.report!.areas[0].scenarios.find(item => item.scenarioId === "PROFILE");
          observations.push({ variant: "profile-persistence", repetition, expected: "pass", actual: browser?.screenshots.length ? items.find(item => item.id === "PERSIST")?.verdict ?? "cannot_judge" : "cannot_judge", runDir: result.runDir });
        }
      } catch (error) {
        observations.push({ variant: variant.file, repetition, expected: variant.expected, actual: "cannot_judge", error: error instanceof Error ? error.message : String(error) });
      }
      summarize();
      throwIfCancelled();
    }
    const summary = summarize();
    console.log(JSON.stringify(summary.metrics));
    console.log(`${summary.passed ? "Passed" : "Failed"}: ${path.join(output, "reference-results.json")}`);
    if (!summary.passed) process.exitCode = 1;
  } finally {
    summarize();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
  }
}

withCliSignals(main).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
});
