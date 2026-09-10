import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const methods = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(methods, "../..");
const experiment = path.resolve(
  process.argv[2] ?? path.join(repository, ".agent-eval/experiments/marketing-improvement"),
);
if (fs.existsSync(experiment))
  throw new Error(`Refusing to overwrite existing experiment: ${experiment}`);
const project = path.join(experiment, "project");
const source = fs.readFileSync(path.join(repository, "docs/marketing/index.html"), "utf8");
const replaceOnce = (text, before, after) => {
  if (text.split(before).length !== 2)
    throw new Error(`Mutation anchor must occur once: ${before}`);
  return text.replace(before, after);
};
const oldAction =
  "Leave the accepted revision at 82. Restore the test dependency and rerun the candidate before deciding whether to keep it.";
const validAction =
  "Keep using the previously accepted 82-point revision. Repair the unavailable receipt service and collect a fresh evaluation before making an acceptance decision.";
const badAction =
  "The receipt outage is temporary. Keep this candidate as the new accepted revision and ship it now; collect the missing evidence later.";
const bestBug = (text) =>
  replaceOnce(
    text,
    "revisions[i].decision === 'KEEP' || revisions[i].decision === 'BASELINE'",
    "revisions[i].decision === 'KEEP' || revisions[i].decision === 'BASELINE' || revisions[i].decision === 'REJECT'",
  );
const pendingBug = (text) =>
  replaceOnce(
    text,
    "const revealed = phase === -1 || phase === 2;",
    "const revealed = phase === -1 || phase >= 1;",
  );
const variants = {
  original: source,
  equivalent: replaceOnce(source, oldAction, validAction),
  guidance: replaceOnce(source, oldAction, badAction),
  accepted: bestBug(source),
  pending: pendingBug(source),
  combined: pendingBug(bestBug(replaceOnce(source, oldAction, badAction))),
};
// Validate source anchors and required methods before creating the exercise.
// Reserve its directory exclusively so concurrent preparation cannot overwrite it.
for (const file of ["collect.mjs", "check.mjs", "demo.yaml"])
  fs.accessSync(path.join(methods, file), fs.constants.R_OK);
fs.mkdirSync(path.dirname(experiment), { recursive: true });
fs.mkdirSync(experiment);
fs.mkdirSync(path.join(project, "site"), { recursive: true });
fs.mkdirSync(path.join(project, "evals"));
fs.mkdirSync(path.join(project, ".aek-authoring"));
fs.mkdirSync(path.join(experiment, "variants"));
for (const [name, html] of Object.entries(variants))
  fs.writeFileSync(path.join(experiment, "variants", `${name}.html`), html);
fs.writeFileSync(path.join(project, "site/index.html"), source);
for (const file of ["collect.mjs", "check.mjs", "demo.yaml"])
  fs.copyFileSync(path.join(methods, file), path.join(project, "evals", file));
const config = {
  version: 1,
  project: { name: "Marketing decision exercise", root: "." },
  target: { kind: "repository" },
  agent: { provider: "mock" },
  judge: { provider: "codex", model: "gpt-6-astra", effort: "high", timeoutSeconds: 300 },
  paths: { specs: "evals/demo.yaml", runs: "../runs" },
  scoring: { minimumCoverage: 100, partialCredit: 0.5 },
};
fs.writeFileSync(path.join(project, "evalkit.yaml"), YAML.stringify(config));
const sourceRef = {
  kind: "document",
  ref: "docs/marketing/README.md: playback, accepted-score, and illustrative-result contracts; original index.html: authored revision scenario data",
};
const requirements = [
  [
    "BEST",
    "Rejected and unverified revisions preserve the accepted result",
    "Revision 02: score 77, accepted score 68, failed gates. Revision 04: no score, coverage 58%, accepted score 82.",
  ],
  [
    "PENDING",
    "Results remain pending until evaluation completes",
    "Preparation and evaluation withhold results; pause/resume preserves phase and remaining time.",
  ],
  [
    "GUIDANCE",
    "Missing evidence requires another evaluation before accepting a candidate",
    "The Revision 04 next action requires restoring the dependency or obtaining evidence and rerunning before acceptance.",
  ],
];
fs.writeFileSync(
  path.join(project, ".aek-authoring/plan.json"),
  JSON.stringify(
    {
      version: 1,
      scope: {
        mode: "feature",
        description:
          "Bounded experiment on the documented marketing demo; selected by Codex under the user's authorization to perform an end-to-end exercise. No claim of user review of this specific inventory.",
      },
      config: "evalkit.yaml",
      discovery: { sources: [sourceRef], remaining: [] },
      areas: [{ id: "demo", title: "Marketing decision semantics", sources: [sourceRef] }],
      decisions: [],
      requirements: requirements.map(([id, statement, acceptance]) => ({
        id,
        area: "demo",
        statement,
        acceptance,
        sources: [sourceRef],
        priority: "critical",
        decisionIds: [],
        dependsOn: [],
        evidence:
          "Executed browser observations, retained states.json, and screenshot of the unverified inspector.",
        preparation:
          "Load the self-contained snapshotted HTML in a fresh browser context; control the browser clock; no external services.",
        confirmedBy:
          "Documented demo contract, interpreted by Codex for this bounded exercise; not a human annotation",
        checks: [{ area: "demo", rubric: id }],
        trials: [],
      })),
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(experiment, "expected.json"),
  JSON.stringify(
    {
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      expected: {
        original: { BEST: "pass", PENDING: "pass", GUIDANCE: "pass" },
        equivalent: { BEST: "pass", PENDING: "pass", GUIDANCE: "pass" },
        guidance: { BEST: "pass", PENDING: "pass", GUIDANCE: "fail" },
        accepted: { BEST: "fail", PENDING: "fail", GUIDANCE: "pass" },
        pending: { BEST: "pass", PENDING: "fail", GUIDANCE: "pass" },
        combined: { BEST: "fail", PENDING: "fail", GUIDANCE: "fail" },
      },
      note: "Expectations authored before runs from documented product contracts. These are not independent human labels. Only site/index.html enters target collection; variant names and this oracle are outside the project.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ experiment, project, config: path.join(project, "evalkit.yaml") }, null, 2),
);
