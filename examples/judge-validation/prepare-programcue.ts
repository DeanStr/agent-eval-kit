import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "../../src/config.js";
import { loadSpecs, loadSelectedSpecs } from "../../src/specs.js";
import { runEvaluation } from "../../src/runner.js";
import { assertArtifactIntegrity } from "../../src/integrity.js";
import { sha256, writeJson } from "../../src/io.js";
import type { ValidationDataset, ValidationLabels } from "../../src/judge-validation.js";
import type { ScenarioEvidence } from "../../src/types.js";
import { captureVersionHistoryFixture } from "./version-history-fixture.js";

if (process.argv.length !== 4)
  throw new Error("Usage: tsx prepare-programcue.ts /path/to/programcue NEW_EXPERIMENT_DIRECTORY");
const application = fs.realpathSync(process.argv[2]!);
const output = path.resolve(process.argv[3]!);
const original = path.join(application, "evals/.agent-eval/runs/2026-09-06T11-59-52");
const originalIndex = assertArtifactIntegrity(original, { require: true })!;
const originalSpec = loadSelectedSpecs(path.join(original, "inputs/specs"), "all")[0]!;
const criterion = originalSpec.rubric.find((item) => item.id === "PC-VERSION-HISTORY");
if (!criterion) throw new Error("Retained ProgramCue run lacks PC-VERSION-HISTORY");
const evidence = JSON.parse(
  fs.readFileSync(path.join(original, "PC-FILES/evidence.json"), "utf8"),
) as ScenarioEvidence;
if (evidence.outcome !== "completed" || !evidence.checkpoints?.versions)
  throw new Error("Retained ProgramCue version-history checkpoint is unavailable");
const previous = evidence.files?.find((file) => file.label === "previous-version");
if (!previous) throw new Error("Retained ProgramCue checkpoint lacks the v1 download");
const screenshotLabels = ["versions-after-reload", "expanded-clean-version-history"];
const images = screenshotLabels.map((label, i) => {
  const screenshot = evidence.screenshots.find((shot) => shot.label === label);
  if (!screenshot) throw new Error(`Missing retained screenshot: ${label}`);
  return { label, source: `image${i}`, original: path.join(original, "PC-FILES", screenshot.path) };
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
const project = path.join(output, "project");
fs.mkdirSync(path.join(project, "data"), { recursive: true });
fs.mkdirSync(path.join(project, "evals"));
fs.copyFileSync(
  path.join(import.meta.dirname, "collect-retained.mjs"),
  path.join(project, "evals/collect.mjs"),
);
const sources: Record<string, string> = {
  record: "data/record.json",
  previous: "data/previous.pdf",
  scope: "data/scope.txt",
};
for (const image of images) {
  sources[image.source] = `data/${image.source}.png`;
  fs.copyFileSync(image.original, path.join(project, sources[image.source]!));
}
fs.copyFileSync(
  path.join(original, "PC-FILES", previous.path),
  path.join(project, "data/previous.pdf"),
);
const historicalRecord = {
  summary:
    "Review of retained local ProgramCue evidence from 2026-09-06. No current application actions or external acceptance are claimed.",
  observations: [
    ...evidence.observations,
    `Successful historical v1 download retained: ${previous.filename}; ${previous.bytes} bytes; SHA-256 ${previous.sha256}.`,
    `Original checkpoint versions: ${JSON.stringify(evidence.checkpoints.versions)}. Step numbers refer to the historical run.`,
  ],
  images: images.map(({ label, source }) => ({ label, source })),
  imageExtraction:
    "Historical screenshot copied from the verified source run and normalized by the collector; this collection did not operate the application.",
};
writeJson(path.join(project, "data/record.json"), historicalRecord);
const baseSpec = {
  id: "file-review",
  title: "Historical ProgramCue version history",
  weight: 100,
  description:
    "Bounded historical and synthetic version-history review; no current or hosted acceptance.",
  scenarios: [
    {
      id: "HISTORY",
      name: "Read retained historical version history",
      kind: "command",
      instructions:
        "Read only the supplied evidence, preserving its stated historical or synthetic provenance. Missing observations remain unavailable.",
      collect: {
        command: "node evals/collect.mjs",
        methodFiles: ["evals/collect.mjs"],
        sources,
        images: screenshotLabels,
        files: ["previous"],
      },
    },
  ],
  rubric: [{ ...criterion, scenarios: ["HISTORY"], checkpoints: undefined }],
};
const config = {
  version: 1,
  project: { name: "ProgramCue historical checkpoint review", root: "." },
  target: { kind: "repository" },
  agent: { provider: "mock" },
  judge: { provider: "codex", model: "gpt-6-astra", effort: "medium", timeoutSeconds: 300 },
  paths: { specs: "evals/original.yaml", runs: "../collections" },
  scoring: { minimumCoverage: 100 },
};
fs.writeFileSync(path.join(project, "evals/original.yaml"), YAML.stringify(baseSpec));
fs.writeFileSync(
  path.join(project, "evals/scoped.yaml"),
  YAML.stringify({
    ...baseSpec,
    rubric: [
      {
        ...baseSpec.rubric[0],
        passCriteria:
          "The supplied post-reload history shows v1 and v2 retained, v2 marked latest/current, and a successful retained v1 download establishes accessibility. Content-byte correctness of both PDFs and an individual v2 download belong to separate deterministic checks. Judge this visible-history/accessibility contract only. If the history, latest marker, or successful v1 download is unavailable, abstain.",
      },
    ],
  }),
);
const configurations = [];
for (const id of ["original", "scoped"]) {
  const file = path.join(project, `judge-${id}.yaml`);
  fs.writeFileSync(
    file,
    YAML.stringify({ ...config, paths: { ...config.paths, specs: `evals/${id}.yaml` } }),
  );
  configurations.push({ id, config: path.relative(output, file) });
}
// Use the normal authoring maintenance location and template vocabulary.
const reviewDir = path.join(project, ".aek-authoring/reviews");
fs.mkdirSync(reviewDir, { recursive: true });
const review = path.join(reviewDir, "programcue-file-history.md");
fs.writeFileSync(
  review,
  `# Evaluation maintenance review: programcue-file-history\n\n- Reviewer and role: Codex agent assessment; no human approval implied\n- Review type: initial bounded baseline; no prior .aek-authoring review found in ProgramCue\n- Previous review: ProgramCue evals/README.md file-regression review and docs/DECISIONS.md file-check scope decisions\n- Reviewed revision: historical run 2026-09-06T11-59-52, artifact root ${originalIndex.rootSha256}\n- Scope and limits: PC-VERSION-HISTORY checkpoint only; historical local evidence, no current application or hosted acceptance\n\n## Findings and decisions\n\nThe original model returned partial because it requested content checks for both PDFs and an individual v2 download. ProgramCue's existing decision record separates visible history/current markers from deterministic integrity checks. Keep that original judgement unchanged. Compare its criterion with explicit evidence scope on the same historical observations. Withholding the checkpoint must produce cannot_judge even though the known historical application outcome is successful.\n\n## Validation, exercise, and calibration\n\nRetain four sealed review packages in one related evaluation group: historical observations, a withheld checkpoint, a synthetic passing control, and its synthetic latest-marker defect. The fixture pair retains two distinct downloadable PDFs and changes only which version is marked latest/current. Both fixture screenshots and observations come from a local browser capture after reload. Historical and synthetic provenance are explicit. No collected package contains a model judgement or reviewer label. The criterion wording for the scoped candidate follows the pre-existing application decision; no configuration tuning against these cases.\n\n## Handoff\n\nRecord results using the existing improvement exercise decision-journal format. Labels are agent-reviewed; independent human spot-checks and a broader held-out set would strengthen confidence but are not execution prerequisites.\n`,
);
const reviewSources = [
  review,
  path.join(application, "evals/README.md"),
  path.join(application, "docs/DECISIONS.md"),
].map((file) => ({ path: path.relative(output, file), sha256: sha256(fs.readFileSync(file)) }));
const cases: ValidationDataset["cases"] = [];
const labels: ValidationLabels["labels"] = [];
const fixtures = path.join(output, "fixtures");
fs.mkdirSync(fixtures);
for (const [id, scope] of [
  ["p01", "observed"],
  ["p02", "withheld"],
  ["p03", "observed"],
  ["p04", "observed"],
] as const) {
  const synthetic = id === "p03" || id === "p04";
  const defective = id === "p04";
  const fixtureDir = path.join(fixtures, id);
  const sourcesForCase = [...reviewSources];
  if (synthetic) {
    const record = await captureVersionHistoryFixture({
      latestVersion: defective ? 1 : 2,
      previous: fs.readFileSync(path.join(original, "PC-FILES", previous.path)),
      latest: fs.readFileSync(path.join(application, "evals/fixtures/deck-v2.pdf")),
      output: fixtureDir,
    });
    writeJson(path.join(project, "data/record.json"), record);
    for (const image of images)
      fs.copyFileSync(
        path.join(fixtureDir, `${image.label}.png`),
        path.join(project, sources[image.source]!),
      );
    for (const file of ["history.html", "deck-v1.pdf", "deck-v2.pdf"])
      sourcesForCase.push({
        path: path.relative(output, path.join(fixtureDir, file)),
        sha256: sha256(fs.readFileSync(path.join(fixtureDir, file))),
      });
  }
  fs.writeFileSync(path.join(project, "data/scope.txt"), scope);
  const configFile = path.join(project, "judge-original.yaml");
  const collected = await runEvaluation({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(path.join(project, "evals/original.yaml")),
    fixtures: {},
    collectOnly: true,
  });
  const index = assertArtifactIntegrity(collected.runDir, { require: true })!;
  cases.push({
    id,
    group: "programcue-historical-versions",
    split: "evaluation",
    evidence: { directory: path.relative(output, collected.runDir), rootSha256: index.rootSha256 },
    area: "file-review",
    rubric: "PC-VERSION-HISTORY",
    originalRun: { directory: original, rootSha256: originalIndex.rootSha256 },
    sources: sourcesForCase,
  });
  labels.push({
    caseId: id,
    evidenceRootSha256: index.rootSha256,
    area: "file-review",
    rubric: "PC-VERSION-HISTORY",
    reviewer: { name: "Codex bounded historical review", kind: "agent" },
    application: {
      verdict: defective ? "fail" : "pass",
      rationale: synthetic
        ? defective
          ? "The synthetic fixture retains both versions and working downloads but incorrectly marks v1 latest/current instead of v2. This is a seeded fixture defect, not a discovered live ProgramCue defect."
          : "The synthetic control retains both versions, marks v2 latest/current and supplies working downloads. This passes the bounded version-history contract, not current ProgramCue acceptance."
        : "Historical local evidence records both retained versions, current v2, and successful v1 access. Independent integrity checks are separate; no current application state is claimed.",
      sources: [
        ...(synthetic ? [path.relative(output, path.join(fixtureDir, "history.html"))] : []),
        "ProgramCue evals/README.md file-regression review",
        "ProgramCue docs/DECISIONS.md file-evaluation scope",
        `${original}/PC-FILES/evidence.json`,
      ],
    },
    evidence: {
      verdict: defective ? "fail" : scope === "observed" ? "pass" : "cannot_judge",
      rationale: synthetic
        ? defective
          ? "Both fixture screenshots and extracted rows show v1 latest/current while v2 is retained with a later upload timestamp. The required v2 latest marker is contradicted by observed evidence; this is a failure, not missing evidence."
          : "Both fixture screenshots show retained v1 and v2, v2 latest/current, and the retained v1 PDF supports accessibility."
        : scope === "observed"
          ? "Post-reload participant and organizer history show both versions and v2 latest/current; the retained successful v1 PDF establishes accessibility. The version-history contract does not require both individual content downloads."
          : "The checkpoint and downloads are withheld. The historical known-good application outcome cannot support a verdict from this package.",
      refs:
        scope === "observed"
          ? [
              "HISTORY/screenshots/versions-after-reload.png",
              "HISTORY/screenshots/expanded-clean-version-history.png",
              "HISTORY/evidence.json",
            ]
          : [],
    },
  });
}
if (assertArtifactIntegrity(original, { require: true })!.rootSha256 !== originalIndex.rootSha256)
  throw new Error("Historical ProgramCue run changed during review preparation");
writeJson(path.join(output, "cases.json"), { version: 1, cases });
writeJson(path.join(output, "labels.json"), { version: 1, labels });
writeJson(path.join(output, "configurations.json"), { version: 1, configurations });
console.log(`Prepared bounded ProgramCue review: ${output}`);
