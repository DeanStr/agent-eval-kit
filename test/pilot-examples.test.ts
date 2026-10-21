import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertArtifactIntegrity } from "../src/integrity.js";
import { loadJudgeValidationReview } from "../src/judge-validation-review.js";
import { validationLabelsSchema } from "../src/judge-validation.js";
import { escapeHtml } from "../src/report-presentation.js";

const kit = path.resolve(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const example = (file: string, args: string[], expected = 0) => {
  const result = spawnSync(process.execPath, [path.join(kit, "examples", file), ...args], {
    cwd: kit,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return result;
};

test("one-command authoring pilot retains a calibrated regression and restores its target", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-onboarding-pilot-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "project");
  example("authoring/run.mjs", [root]);
  const summaryFile = path.join(root, ".agent-eval/walkthrough/summary.json");
  const summary = read(summaryFile);
  assert.deepEqual(summary.results, {
    good: { score: 100, coverage: 100, gatesPassed: true },
    defect: { score: 25, coverage: 100, gatesPassed: false },
    restored: { score: 100, coverage: 100, gatesPassed: true },
  });
  assert.deepEqual(summary.requirements, [
    { id: "QUANTITY", stage: "calibrated" },
    { id: "EMPTY", stage: "exercised" },
  ]);
  for (const directory of [summary.good, summary.defect, summary.restored])
    assertArtifactIntegrity(path.join(root, directory), { require: true });
  assert.equal(
    fs.readFileSync(path.join(root, "cart.mjs"), "utf8"),
    fs.readFileSync(path.join(kit, "examples/authoring/cart.mjs"), "utf8"),
  );
  assert.ok(fs.existsSync(path.join(root, ".agents/skills/aek-author/SKILL.md")));
  const comparison = read(path.join(root, ".agent-eval/comparison/comparison.json"));
  assert.equal(comparison.compatibility.status, "compatible");
  assert.equal(
    comparison.items.find((item: { id: string }) => item.id === "QUANTITY").change,
    "regressed",
  );
  const bytes = fs.readFileSync(summaryFile);
  example("authoring/run.mjs", [root], 1);
  assert.deepEqual(fs.readFileSync(summaryFile), bytes);
});

test("representative pilot preserves real collected evidence and separates mock abstentions from accuracy", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-pilot-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "pilot");
  example("judge-validation/pilot.mjs", ["prepare", root, "--judge", "mock"]);
  const dataset = read(path.join(root, "cases.json"));
  const labels = validationLabelsSchema.parse(read(path.join(root, "labels.agent.json")));
  assert.equal(dataset.cases.length, 12);
  assert.deepEqual(
    ["pass", "fail", "cannot_judge"].map(
      (verdict) => labels.labels.filter((label) => label.evidence.verdict === verdict).length,
    ),
    [6, 3, 3],
  );
  assert.ok(labels.labels.every((label) => label.reviewer.kind === "agent"));
  assert.throws(() =>
    validationLabelsSchema.parse(read(path.join(root, "human-review.template.json"))),
  );
  const review = fs.readFileSync(path.join(root, "review.html"), "utf8");
  assert.doesNotMatch(
    review,
    /AEK pilot fixture author|Controlled (browser|file|text) fixture:|judge-medium|judge-high/,
  );
  assert.match(review, /Notebook/);
  assert.match(review, /Supplied policy record/);
  assert.equal((review.match(/<section>/g) ?? []).length, 12);
  const reviewCards = new Map(
    [...review.matchAll(/<section><h2>(case-\d+) · [^<]+<\/h2>([\s\S]*?)<\/section>/g)].map(
      (match) => [match[1]!, match[2]!],
    ),
  );
  for (const item of dataset.cases) {
    const directory = path.join(root, item.evidence.directory);
    assert.equal(
      assertArtifactIntegrity(directory, { require: true })!.rootSha256,
      item.evidence.rootSha256,
    );
    const label = labels.labels.find((label) => label.caseId === item.id)!;
    if (item.area === "browser" || item.area === "file") {
      const scenario = item.area === "browser" ? "BROWSE" : "EXPORT";
      const evidence = read(path.join(directory, scenario, "evidence.json"));
      const card = reviewCards.get(item.id);
      assert.ok(card, `Missing review card for ${item.id}`);
      assert.match(card, /&quot;collector&quot;: &quot;command&quot;/);
      assert.match(card, /&quot;kind&quot;: &quot;command&quot;/);
      assert.match(card, /&quot;transcript&quot;: \[/);
      assert.ok(evidence.transcript.length > 0);
      for (const entry of evidence.transcript) {
        assert.ok(card.includes(escapeHtml(JSON.stringify(entry.input.command))));
        assert.ok(card.includes(escapeHtml(JSON.stringify(entry.result))));
      }
    }
    if (item.area === "browser") {
      const evidence = read(path.join(directory, "BROWSE/evidence.json"));
      if (label.evidence.verdict === "cannot_judge") {
        assert.equal(evidence.outcome, "blocked");
        assert.equal(evidence.screenshots.length, 0);
      } else {
        assert.equal(evidence.screenshots.length, 2);
        assert.ok(
          evidence.observations.some((value: string) =>
            value.includes('Before reload: {"quantity":"2"'),
          ),
        );
        const quantity = label.evidence.verdict === "pass" ? "2" : "1";
        assert.ok(
          evidence.observations.some((value: string) =>
            value.includes(`After reload: {"quantity":"${quantity}"`),
          ),
        );
      }
    }
  }
  const configurationFile = path.join(root, "project/judge-high.yaml");
  const configurationBytes = fs.readFileSync(configurationFile);
  const changedConfiguration = JSON.parse(configurationBytes.toString());
  changedConfiguration.judge.model = "changed-after-preparation";
  fs.writeFileSync(configurationFile, JSON.stringify(changedConfiguration));
  const changed = example("judge-validation/pilot.mjs", ["compare", root], 1);
  assert.match(changed.stderr, /prepared pilot input changed.*judge-high/i);
  assert.equal(fs.existsSync(path.join(root, "comparison")), false);
  fs.writeFileSync(configurationFile, configurationBytes);
  for (const file of [
    "labels.agent.json",
    "configurations.json",
    "cases.json",
    "project/specs/browser.yaml",
    "project/specs/file.yaml",
    "project/specs/text.yaml",
  ]) {
    const location = path.join(root, file);
    const original = fs.readFileSync(location);
    const edited = JSON.parse(original.toString());
    if (file === "labels.agent.json") edited.labels[0].reviewer.name = "Changed reviewer";
    else if (file === "configurations.json") edited.configurations.pop();
    else if (file === "cases.json") for (const item of edited.cases) item.split = "development";
    else edited.rubric[0].passCriteria = "Any supplied artifact passes.";
    fs.writeFileSync(location, JSON.stringify(edited));
    assert.match(
      example("judge-validation/pilot.mjs", ["compare", root], 1).stderr,
      /prepared pilot (input|case identities) changed/i,
    );
    assert.equal(fs.existsSync(path.join(root, "comparison")), false);
    fs.writeFileSync(location, original);
  }
  example("judge-validation/pilot.mjs", ["compare", root]);
  const comparison = loadJudgeValidationReview(path.join(root, "comparison"));
  assert.equal(comparison.report.observations.length, 24);
  for (const result of comparison.report.results as Array<{
    metrics: Record<string, { count: number }>;
  }>) {
    assert.equal(result.metrics.executionErrors!.count, 0);
    assert.equal(result.metrics.abstentions!.count, 12);
    assert.equal(result.metrics.decisionCoverage!.count, 0);
    assert.equal(result.metrics.unsupportedDecisions!.count, 0);
  }
  const summary = read(path.join(root, "pilot-summary.json"));
  assert.equal(summary.judge, "mock");
  assert.equal(summary.comparisonSha256, comparison.sha256);
  assert.ok(summary.timings.every((item: { durationMs: number }) => item.durationMs >= 0));
  assert.match(
    fs.readFileSync(path.join(root, "pilot-summary.html"), "utf8"),
    /not model accuracy evidence/,
  );
  example("judge-validation/pilot.mjs", ["summarize", root], 1);
  const summaryFiles = ["pilot-summary.json", "pilot-summary.html"];
  for (const file of summaryFiles) fs.unlinkSync(path.join(root, file));
  const specFile = path.join(root, "project/specs/browser.yaml");
  const specBytes = fs.readFileSync(specFile);
  const alteredSpec = JSON.parse(specBytes.toString());
  alteredSpec.rubric[0].passCriteria = "Any supplied artifact passes.";
  fs.writeFileSync(configurationFile, JSON.stringify(changedConfiguration));
  fs.writeFileSync(specFile, JSON.stringify(alteredSpec));
  example("judge-validation/pilot.mjs", ["summarize", root]);
  assert.deepEqual(read(path.join(root, "pilot-summary.json")), summary);
  fs.writeFileSync(configurationFile, configurationBytes);
  fs.writeFileSync(specFile, specBytes);
  for (const file of summaryFiles) fs.unlinkSync(path.join(root, file));
  const comparisonFile = path.join(root, "comparison/validation-results.json");
  const comparisonBytes = fs.readFileSync(comparisonFile);
  const changedComparison = JSON.parse(comparisonBytes.toString());
  changedComparison.inputs.configurations[1].sha256 = "0".repeat(64);
  fs.writeFileSync(comparisonFile, JSON.stringify(changedComparison));
  assert.match(
    example("judge-validation/pilot.mjs", ["summarize", root], 1).stderr,
    /prepared pilot input changed.*judge-high/i,
  );
  assert.ok(summaryFiles.every((file) => !fs.existsSync(path.join(root, file))));
  fs.writeFileSync(comparisonFile, comparisonBytes);
  // Bypass the example preflight through the general CLI, which permits rubric
  // experiments. Summarizing this prepared pilot must still reject changed specs.
  const comparisonRoot = path.join(root, "comparison");
  const savedComparison = path.join(root, "original-comparison");
  fs.renameSync(comparisonRoot, savedComparison);
  fs.writeFileSync(specFile, JSON.stringify(alteredSpec));
  const altered = spawnSync(
    process.execPath,
    [
      path.join(kit, "dist/cli.js"),
      "judge",
      "validate",
      "--dataset",
      "cases.json",
      "--labels",
      "labels.agent.json",
      "--configurations",
      "configurations.json",
      "--output",
      "comparison",
    ],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(altered.status, 0, `${altered.stdout}\n${altered.stderr}`);
  fs.writeFileSync(specFile, specBytes);
  assert.match(
    example("judge-validation/pilot.mjs", ["summarize", root], 1).stderr,
    /prepared pilot input changed.*specs\/browser/i,
  );
  assert.ok(summaryFiles.every((file) => !fs.existsSync(path.join(root, file))));
  fs.rmSync(comparisonRoot, { recursive: true });
  fs.renameSync(savedComparison, comparisonRoot);
  const metadata = path.join(root, "pilot.json");
  const original = fs.readFileSync(metadata);
  fs.writeFileSync(
    metadata,
    JSON.stringify({ ...JSON.parse(original.toString()), judge: "codex" }),
  );
  assert.match(
    example("judge-validation/pilot.mjs", ["summarize", root], 1).stderr,
    /metadata is missing or changed/,
  );
  fs.writeFileSync(metadata, original);
  const first = comparison.report.observations[0]!;
  assert.ok(first.runDir);
  fs.appendFileSync(path.join(first.runDir, "report.json"), " ");
  const invalid = example("judge-validation/pilot.mjs", ["summarize", root], 1);
  assert.match(invalid.stderr, /mismatch|changed|integrity/i);
});
