import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Runs from a source build or the installed package, without tsx or model access.
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const destination = process.argv[2];
if (!destination || process.argv.length !== 3)
  throw new Error("Usage: node examples/judge-validation/run.mjs NEW_DIRECTORY");
const root = path.resolve(destination);
fs.mkdirSync(root); // Refuse to replace an existing experiment.
const project = path.join(root, "project");
fs.mkdirSync(project);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const aek = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`aek ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
};
fs.writeFileSync(
  path.join(project, "check.mjs"),
  `import fs from 'node:fs';
const verdict = JSON.parse(fs.readFileSync('observation.json', 'utf8')).verdict;
console.log(JSON.stringify({ verdict, confidence: 'high', reasoning: verdict === 'cannot_judge' ? 'The synthetic observation is withheld.' : 'The synthetic observation records ' + verdict + '.', evidenceRefs: [] }));
`,
);
write(path.join(project, "spec.yaml"), {
  id: "demo",
  title: "Synthetic observations",
  weight: 100,
  description: "Offline demonstration of validation reports; not a judge accuracy benchmark.",
  scenarios: [],
  rubric: [
    {
      id: "CHECK",
      criterion: "The observed synthetic check succeeds",
      passCriteria: "The observation records pass.",
      weight: 1,
      scenarios: [],
      gate: true,
      grader: {
        type: "command",
        output: "json",
        command: "node check.mjs",
        methodFiles: ["check.mjs"],
      },
    },
  ],
});
const config = {
  version: 1,
  project: { name: "Offline judge validation", root: "." },
  target: { kind: "command" },
  agent: { provider: "mock" },
  judge: { provider: "mock" },
  paths: { specs: "spec.yaml", runs: "../collections" },
};
const configFile = path.join(project, "evalkit.yaml");
write(configFile, config);
write(path.join(project, "alternate.yaml"), {
  ...config,
  judge: { provider: "mock", model: "alternate" },
});
const cases = [],
  labels = [];
for (const [index, verdict] of ["pass", "fail", "cannot_judge"].entries()) {
  write(path.join(project, "observation.json"), { verdict });
  const runs = path.join(root, "collections");
  const before = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  aek("collect", "--config", configFile);
  const added = fs.readdirSync(runs).filter((name) => !before.includes(name));
  if (added.length !== 1) throw new Error("Expected one sealed collection per case");
  const directory = path.join(runs, added[0]);
  const { rootSha256 } = JSON.parse(
    fs.readFileSync(path.join(directory, "artifact-index.json"), "utf8"),
  );
  const id = `case-${index + 1}`;
  cases.push({
    id,
    group: "synthetic-family",
    split: "development",
    evidence: { directory, rootSha256 },
    area: "demo",
    rubric: "CHECK",
    sources: [],
  });
  labels.push({
    caseId: id,
    evidenceRootSha256: rootSha256,
    area: "demo",
    rubric: "CHECK",
    reviewer: { name: "Synthetic fixture author", kind: "agent" },
    application: {
      verdict: verdict === "cannot_judge" ? "unknown" : verdict,
      rationale: "Synthetic fixture expectation; no real application outcome is claimed.",
      sources: ["Offline example fixture definition"],
    },
    evidence: {
      verdict,
      rationale:
        verdict === "cannot_judge"
          ? "The synthetic observation is withheld."
          : `The collected command output records ${verdict}.`,
      refs: verdict === "cannot_judge" ? [] : ["graders/CHECK.stdout.txt"],
    },
  });
}
write(path.join(root, "cases.json"), { version: 1, cases });
write(path.join(root, "labels.json"), { version: 1, labels });
write(path.join(root, "configurations.json"), {
  version: 1,
  configurations: [
    { id: "original", config: "project/evalkit.yaml" },
    { id: "alternate", config: "project/alternate.yaml" },
  ],
});
aek(
  "judge",
  "validate",
  "--dataset",
  "cases.json",
  "--labels",
  "labels.json",
  "--configurations",
  "configurations.json",
  "--output",
  "comparison",
);
console.log(`Open ${path.join(root, "comparison/validation-results.html")}`);
