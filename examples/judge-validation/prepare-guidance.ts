import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { loadConfig } from "../../src/config.js";
import { loadSpecs } from "../../src/specs.js";
import { runEvaluation } from "../../src/runner.js";
import { assertArtifactIntegrity } from "../../src/integrity.js";
import { sha256, writeJson } from "../../src/io.js";
import type { ValidationDataset, ValidationLabels } from "../../src/judge-validation.js";

const repository = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(process.argv[2] ?? ".agent-eval/experiments/judge-guidance");
const prepared = spawnSync(
  process.execPath,
  ["examples/improvement-exercise/prepare.mjs", output],
  {
    cwd: repository,
    encoding: "utf8",
  },
);
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) throw new Error(prepared.stderr);
const project = path.join(output, "project");
fs.copyFileSync(
  path.join(project, "evals/collect.mjs"),
  path.join(project, "evals/collect-browser.mjs"),
);
fs.copyFileSync(
  path.join(import.meta.dirname, "collect-guidance.mjs"),
  path.join(project, "evals/collect.mjs"),
);
const original = YAML.parse(fs.readFileSync(path.join(project, "evals/demo.yaml"), "utf8"));
const scenario = original.scenarios[0];
scenario.collect.methodFiles = ["evals/collect.mjs", "evals/collect-browser.mjs"];
scenario.collect.sources.scope = "site/scope.txt";
const guidance = original.rubric.find((item: { id: string }) => item.id === "GUIDANCE");
if (!guidance) throw new Error("Improvement exercise is missing GUIDANCE");
original.rubric = [guidance];
fs.writeFileSync(path.join(project, "evals/demo.yaml"), YAML.stringify(original));
const baseConfig = YAML.parse(fs.readFileSync(path.join(project, "evalkit.yaml"), "utf8"));
baseConfig.paths.runs = "../collections";
// Pin the exercised judge settings; users can edit candidates before comparison.
const configurations = [];
for (const [id, effort] of [
  ["medium", "medium"],
  ["high", "high"],
]) {
  const file = path.join(project, `judge-${id}.yaml`);
  fs.writeFileSync(file, YAML.stringify({ ...baseConfig, judge: { ...baseConfig.judge, effort } }));
  configurations.push({ id, config: path.relative(output, file) });
}
const configFile = path.join(project, "judge-medium.yaml");
const planFile = path.join(project, ".aek-authoring/plan.json");
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
plan.config = "judge-medium.yaml";
plan.scope.description =
  "Bounded judge-validation inventory for demo/GUIDANCE; BEST and PENDING are outside this study. Agent-authored scope, not human approval.";
plan.requirements = plan.requirements.filter((item: { id: string }) => item.id === "GUIDANCE");
writeJson(planFile, plan);
const cases: ValidationDataset["cases"] = [];
const labels: ValidationLabels["labels"] = [];
const variants = [
  { id: "c01", variant: "original", scope: "observed", application: "pass", evidence: "pass" },
  { id: "c02", variant: "equivalent", scope: "observed", application: "pass", evidence: "pass" },
  { id: "c03", variant: "guidance", scope: "observed", application: "fail", evidence: "fail" },
  { id: "c04", variant: "combined", scope: "observed", application: "fail", evidence: "fail" },
  {
    id: "c05",
    variant: "original",
    scope: "withheld",
    application: "pass",
    evidence: "cannot_judge",
  },
  {
    id: "c06",
    variant: "guidance",
    scope: "withheld",
    application: "fail",
    evidence: "cannot_judge",
  },
] as const;
for (const variant of variants) {
  fs.copyFileSync(
    path.join(output, "variants", `${variant.variant}.html`),
    path.join(project, "site/index.html"),
  );
  fs.writeFileSync(path.join(project, "site/scope.txt"), variant.scope);
  const result = await runEvaluation({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(path.join(project, "evals/demo.yaml")),
    fixtures: {},
    collectOnly: true,
  });
  const index = assertArtifactIntegrity(result.runDir, { require: true })!;
  cases.push({
    id: variant.id,
    group: "marketing-guidance-family",
    split: "development",
    evidence: { directory: path.relative(output, result.runDir), rootSha256: index.rootSha256 },
    area: "demo",
    rubric: "GUIDANCE",
    sources: [],
  });
  labels.push({
    caseId: variant.id,
    evidenceRootSha256: index.rootSha256,
    area: "demo",
    rubric: "GUIDANCE",
    reviewer: { name: "Codex exercise author", kind: "agent" },
    application: {
      verdict: variant.application,
      rationale:
        variant.application === "pass"
          ? "The authored action requires evidence before accepting the candidate."
          : "The authored action recommends immediate acceptance and shipment before collecting evidence.",
      sources: [`expected.json#${variant.variant}.GUIDANCE`, `variants/${variant.variant}.html`],
    },
    evidence: {
      verdict: variant.evidence,
      rationale:
        variant.scope === "withheld"
          ? "The recommendation is not supplied. A known application defect or success cannot replace absent observations."
          : variant.evidence === "pass"
            ? "Observed action requires rerunning before acceptance; equivalent wording is valid."
            : "Observed action says keep and ship the unverified candidate now; other correct badges cannot compensate.",
      refs:
        variant.scope === "withheld"
          ? []
          : ["DEMO/evidence.json#observation-3", "DEMO/screenshots/unverified.png"],
    },
  });
}
const reviewDir = path.join(project, ".aek-authoring/reviews");
fs.mkdirSync(reviewDir, { recursive: true });
const review = path.join(reviewDir, "judge-validation.md");
fs.writeFileSync(
  review,
  `# Evaluation maintenance review: judge-validation\n\n- Reviewer and role: Codex agent assessment; no human approval implied\n- Review type: initial bounded judge-validation baseline\n- Previous review: none in this isolated exercise\n- Scope and limits: demo/GUIDANCE only; BEST and PENDING remain outside this study\n\n## Findings and decisions\n\nValid wording, acceptance-before-evidence defects, and withheld observations form one related family. All six cases stay in development. Reviewer labels remain outside the project. Application expectations from expected.json do not establish what a withheld observation supports.\n\n## Validation, exercise, and calibration\n\nSix completed, sealed collections; no judge calls during preparation. Compare both pinned configurations against these exact bundles. No held-out accuracy claim.\n\n## Handoff\n\nRecord comparison findings in the existing improvement exercise decision journal using record-review.mjs. Keep errors and abstentions separate.\n`,
);
for (const item of cases)
  item.sources.push({
    path: path.relative(output, review),
    sha256: sha256(fs.readFileSync(review)),
  });
writeJson(path.join(output, "cases.json"), { version: 1, cases });
writeJson(path.join(output, "labels.json"), { version: 1, labels });
writeJson(path.join(output, "configurations.json"), { version: 1, configurations });
console.log(
  `Prepared ${output}; compare with pnpm judge:validate --dataset ${output}/cases.json --labels ${output}/labels.json --configurations ${output}/configurations.json --output ${output}/comparison`,
);
