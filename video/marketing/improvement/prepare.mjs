import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { copyTarget, hashTarget } from "./snapshot.mjs";
const methods = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(methods, "../../..");
const kinds = {
  dashboard: {
    source: "examples/visual/index.html",
    target: "dashboard.html",
    original: "original.html",
    name: "Delivery dashboard improvement",
    judge: { provider: "codex", model: "gpt-6-astra", effort: "medium", timeoutSeconds: 300 },
    scope:
      "Existing sample dashboard, synthetic delivery data. No seeded defects. Criteria authored before revisions. Coding-agent edits in this session; AEK evaluates and compares.",
  },
  dispatch: {
    source: "video/marketing/assets/dispatch-baseline",
    target: "dispatch",
    original: "original",
    name: "Dispatch workflow improvement",
    judge: {
      provider: "codex",
      model: "gpt-6-astra",
      effort: "medium",
      timeoutSeconds: 300,
      voting: { minimumVotes: 3, maximumVotes: 5, agreement: 0.8, minimumConfidence: 0.55 },
    },
    scope:
      "Human-directed dispatch prototype with a synthetic fixture. No seeded defects. Criteria derived from the documented dispatch quality targets and frozen before the baseline. Coding-agent edits in this session; AEK evaluates and compares.",
  },
};
const kind = process.argv[2];
if (!Object.hasOwn(kinds, kind)) throw Error("Usage: prepare.mjs dashboard|dispatch");
const plan = kinds[kind];
fs.mkdirSync(path.join(root, ".agent-eval/marketing-video"), { recursive: true });
const session = fs.mkdtempSync(path.join(root, `.agent-eval/marketing-video/${kind}-`));
const project = path.join(session, "project");
fs.mkdirSync(path.join(project, "evals"), { recursive: true });
const source = path.join(root, plan.source);
copyTarget(source, path.join(project, plan.target));
copyTarget(source, path.join(session, plan.original));
for (const name of ["collect.mjs", "check.mjs", "suite.yaml"])
  fs.copyFileSync(path.join(methods, kind, name), path.join(project, "evals", name));
fs.writeFileSync(
  path.join(project, "evalkit.yaml"),
  YAML.stringify({
    version: 1,
    project: { name: plan.name, root: "." },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: plan.judge,
    paths: { specs: "evals/suite.yaml", runs: "../runs" },
    scoring: { minimumCoverage: 100, partialCredit: 0.5 },
  }),
);
fs.writeFileSync(
  path.join(session, "origin.json"),
  JSON.stringify(
    {
      kind,
      source: plan.source,
      target: plan.target,
      sha256: hashTarget(source),
      capturedAt: new Date().toISOString(),
      scope: plan.scope,
    },
    null,
    2,
  ),
);
console.log(session);
