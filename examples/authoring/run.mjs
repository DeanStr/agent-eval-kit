import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const destination = process.argv[2];
if (!destination || process.argv.length !== 3)
  throw new Error("Usage: node examples/authoring/run.mjs NEW_DIRECTORY");
const root = path.resolve(destination);
const example = path.dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
fs.accessSync(cli);
fs.mkdirSync(root); // Retain prior trials; never replace an existing project.
for (const file of [
  "cart.mjs",
  "cart.test.mjs",
  "test-adapter.mjs",
  "check.mjs",
  "evalkit.yaml",
  "plan.json",
  "README.md",
])
  fs.copyFileSync(path.join(example, file), path.join(root, file));
fs.cpSync(path.join(example, "specs"), path.join(root, "specs"), { recursive: true });
const logs = path.join(root, ".agent-eval", "walkthrough");
fs.mkdirSync(logs, { recursive: true });
const steps = [];
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const run = (args, expectedExit = 0) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  const ordinal = String(steps.length + 1).padStart(2, "0");
  fs.writeFileSync(path.join(logs, `${ordinal}.stdout.txt`), result.stdout ?? "");
  fs.writeFileSync(path.join(logs, `${ordinal}.stderr.txt`), result.stderr ?? "");
  steps.push({ args, expectedExit, exitCode: result.status, durationMs: Date.now() - started });
  write(path.join(logs, "steps.json"), steps);
  if (result.error) throw result.error;
  if (result.status !== expectedExit)
    throw new Error(`aek ${args.join(" ")} exited ${result.status}; see ${logs}`);
  console.log(`aek ${args.join(" ")}: exit ${result.status}`);
  return result.stdout;
};
const evaluate = (expectedExit) => {
  const runs = path.join(root, ".agent-eval", "runs");
  const before = new Set(fs.existsSync(runs) ? fs.readdirSync(runs) : []);
  run(["run"], expectedExit);
  const added = fs.readdirSync(runs).filter((name) => !before.has(name));
  if (added.length !== 1) throw new Error("Expected exactly one new evaluation run");
  return path.join(".agent-eval", "runs", added[0]);
};

run(["author", "install"]);
run(["author", "init"]);
fs.copyFileSync(path.join(root, "plan.json"), path.join(root, ".aek-authoring", "plan.json"));
run(["author", "validate", "--require-ready"]);
run(["validate"]);
run(["run", "--dry-run"]);
const good = evaluate(0);
const target = path.join(root, "cart.mjs");
const original = fs.readFileSync(target);
let defect;
try {
  fs.writeFileSync(
    target,
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  defect = evaluate(2);
  run(
    [
      "compare",
      "--baseline",
      good,
      "--candidate",
      defect,
      "--fail-on-regression",
      "--output",
      ".agent-eval/comparison",
    ],
    2,
  );
} finally {
  fs.writeFileSync(target, original);
}
const restored = evaluate(0);
const mapFile = path.join(root, ".aek-authoring", "plan.json");
const map = json(mapFile);
for (const requirement of map.requirements)
  requirement.trials = [
    { kind: "good", run: good, rationale: "Original quantity-aware fixture implementation." },
    {
      kind: "defect",
      run: defect,
      rationale: "Disposable target ignores quantity; checker fixed.",
    },
  ];
write(mapFile, map);
const status = JSON.parse(run(["author", "status", "--json"]));
run(["verify", "--run", restored]);
const summary = {
  version: 1,
  project: root,
  good,
  defect,
  restored,
  comparison: ".agent-eval/comparison/comparison.html",
  requirements: status.requirements.map(({ id, stage }) => ({ id, stage })),
  results: Object.fromEntries(
    Object.entries({ good, defect, restored }).map(([name, directory]) => {
      const report = json(path.join(root, directory, "report.json"));
      return [
        name,
        {
          score: report.overallScorePct,
          coverage: report.overallCoveragePct,
          gatesPassed: report.gates.passed,
        },
      ];
    }),
  ),
  steps,
  limitations: [
    "Synthetic fixture with real command execution; no model or human-review accuracy measured.",
    "QUANTITY is calibrated; this defect leaves EMPTY correct, so EMPTY is only exercised.",
    "The installed authoring skill is available for a later interview; this scripted fixture does not measure interview quality.",
  ],
};
write(path.join(logs, "summary.json"), summary);
console.log(
  `Open ${path.join(root, summary.comparison)}\nSummary: ${path.join(logs, "summary.json")}`,
);
