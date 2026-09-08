import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STARTER_KINDS = ["web", "repository", "command", "artifact"] as const;
export type StarterKind = (typeof STARTER_KINDS)[number];

function configTemplate(kind: StarterKind): string {
  return `version: 1
project:
  name: Example project
  root: .

target:
  kind: ${kind === "artifact" ? "repository" : kind}
${
  kind === "web"
    ? `  url: http://127.0.0.1:3000
  allowedOrigins: [http://127.0.0.1:3000]
  # For a local application, replace these with your commands.
  # setup: pnpm install --frozen-lockfile
  # start: pnpm dev
  # ready:
  #   url: http://127.0.0.1:3000/health
  #   timeoutSeconds: 120
`
    : ""
}
agent:
${kind === "command" || kind === "artifact" ? "  # Collection needs no agent subscription.\n" : ""}  provider: ${kind === "command" || kind === "artifact" ? "mock" : "codex"}
  effort: high
  maxTurns: 30
  timeoutSeconds: 900
judge:
  provider: ${kind === "command" ? "mock" : "codex"}
  effort: high
  timeoutSeconds: 900

paths:
  specs: evals/specs
  fixtures: evals/fixtures.yaml
  runs: .agent-eval/runs
  auth: .agent-eval/auth
  baselines: evals/baselines

scoring:
  partialCredit: 0.5
  minimumCoverage: 80

variables: {}
instructions: Assess only claims supported by collected evidence.
`;
}

const authoringNotes = `# Before running, replace this example with one concrete project requirement.
# Claim: name an observable behavior and its expected result.
# Exercise: specify inputs, actions, and any reload/restart needed to prove it.
# Evidence: capture actual and expected values, images, or file/line references.
# Grader: use commands for exact checks; LLMs for evidence interpretation.
# Use gate: true only for a requirement that must fully pass.
# See ../ONBOARDING.md for preparation and good-versus-broken calibration.
`;

const specs: Record<StarterKind, string> = {
  web: `id: core
title: Primary workflow
weight: 100
description: Prove one concrete user workflow and its persisted result.
scenarios:
  - id: CORE-S1
    name: Create and revisit a record
    kind: browser
    # For a signed-in workflow, capture this persona with aek auth first.
    # persona: buyer
    # requiresAuth: true
    instructions: |
      Replace these steps with the exact screens and fields in your application.
      Create a record using data.uniqueRecordName from the fixtures.
      Capture the submitted values and the success state.
      Reload and locate the record; capture its persisted values.
    successSignals:
      - The submitted record and its values are visible after reload.
rubric:
  - id: CORE-01
    criterion: A created record retains its submitted values after reload
    weight: 1
    gate: true
    scenarios: [CORE-S1]
    grader: { type: llm }
    passCriteria: The unique record exists after reload and its fields match the submitted values. Replace this with the exact fields and expected values.
    evidence: Before-submission and after-reload screenshots showing the record identity and field values.
`,
  repository: `id: core
title: Repository contract
weight: 100
description: Check a documented source-level contract against its implementation.
scenarios:
  - id: CORE-S1
    name: Trace a documented interface
    kind: workspace
    instructions: |
      Replace this with a named public function, command, or module.
      Read its documentation, implementation, and relevant tests.
      Trace one documented input and error path, citing files and lines.
      Workspace tools support listing, reading, and searching only.
      Record source-level findings; do not claim that tests or runtime paths executed.
    successSignals:
      - Documentation and implementation references describe the same interface.
rubric:
  - id: CORE-01
    criterion: The documented interface agrees with the source implementation
    weight: 1
    gate: true
    scenarios: [CORE-S1]
    grader: { type: llm }
    passCriteria: The named interface accepts the documented arguments and implements the documented error path. Replace this with the exact interface and contract; this criterion covers source agreement only.
    evidence: File and line references from both documentation and implementation.
`,
  command: `id: core
title: Command behavior
weight: 100
description: Execute a deterministic behavioral check without a model subscription.
scenarios:
  - id: CORE-S1
    name: Deterministic check placeholder
    kind: workspace
    # This optional placeholder performs no inspection with the offline mock;
    # all measured evidence comes from the command grader below.
    instructions: No agent collection is required; the command grader executes the target.
rubric:
  - id: CORE-01
    criterion: The command produces the expected output and exit status
    weight: 1
    gate: true
    scenarios: []
    grader:
      type: command
      methodFiles: [evals/check.mjs]
      output: json
      command: node evals/check.mjs
      timeoutSeconds: 60
    passCriteria: Replace with a concrete invocation, input, expected stdout or artifact, and exit status.
    evidence: The checker must report actual and expected results from executing the target.
`,
  artifact: `id: core
title: Exported artifact
weight: 100
description: Evaluate the delivered image independently of its producing application.
scenarios:
  - id: CORE-S1
    name: Collect a delivered PNG
    kind: command
    instructions: Collect the exported image without changing the application.
    collect:
      command: node evals/collect.mjs
      methodFiles: [evals/collect.mjs]
      # Replace with your actual delivered PNG, relative to project.root.
      sources: { artifact: exports/result.png }
      images: [export]
rubric:
  - id: CORE-01
    criterion: The exported image is readable and complete
    weight: 1
    gate: true
    scenarios: [CORE-S1]
    grader: { type: llm }
    passCriteria: Replace with the required labels, content, and intended viewing size. Required text must be legible with no clipping or overlap. This image alone does not prove runtime behavior or data accuracy.
    evidence: The complete delivered image at its intended viewing size.
`,
};

const fixturesTemplate = `data:
  # Choose a fresh value for each independent trial and keep it fixed across
  # a calibration pair. Reset backend state before each run.
  uniqueRecordName: AEK calibration record
files: {}
`;

const commandChecker = `// Replace this stub with a check that EXECUTES your target.
// Emit exactly one JSON object on stdout, then exit 0:
// { "verdict": "pass" | "fail", "confidence": "high",
//   "reasoning": "Invocation, actual result, and expected result" }
// A product mismatch is a fail verdict; a broken checker must exit nonzero.
// Use an independent expected value; do not reuse the target's calculation.
throw new Error("Configure evals/check.mjs to execute your command and compare its output and exit status with independently specified expectations. See evals/ONBOARDING.md.");
`;

const artifactCollector = `import fs from "node:fs";
import path from "node:path";

// AEK supplies a sealed snapshot of the declared source artifact.
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const source = context.sources.artifact.path;
const descriptor = fs.openSync(source, "r");
try {
  const signature = Buffer.alloc(8);
  const bytesRead = fs.readSync(descriptor, signature, 0, signature.length, 0);
  if (bytesRead !== signature.length || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Expected a delivered PNG at collect.sources.artifact. Supply a PNG or implement format extraction in evals/collect.mjs and update its provenance.");
  }
} finally {
  fs.closeSync(descriptor);
}
fs.copyFileSync(source, path.join(context.outputDir, "export.png"));
console.log(JSON.stringify({
  version: 1,
  outcome: "completed",
  summary: "Collected the delivered PNG without modification.",
  observations: ["This image supports artifact appearance claims only."],
  images: [{ label: "export", path: "export.png", source: "artifact", extraction: "Copied the snapshotted PNG bytes without modification." }],
}));
`;

function onboardingTemplate(kind: StarterKind): string {
  return `# Onboard this ${kind} evaluation

This kit is an editable starting point. It has not discovered your project's
requirements. Finish the steps below before treating its score as meaningful.

## 1. Prepare the target

Set the project name, root, providers, and target in evalkit.yaml.
${kind === "web" ? "Set the URL and allowed origins. For a local app, configure setup/start/readiness. Capture required personas with `aek auth --persona buyer --at /login`, then set persona and requiresAuth on the scenario." : kind === "artifact" ? "Point collect.sources.artifact in evals/specs/core.yaml at a real delivered PNG. The supplied collector checks the PNG signature and copies sealed bytes; other formats require an explicit extraction implementation and provenance. Collection needs no agent subscription; the configured real judge assesses the image." : kind === "command" ? "Implement evals/check.mjs using your real command, fixed inputs, and independently specified expectations. The stub intentionally fails until configured. This starter uses offline mock providers and a placeholder scenario; only the real command checker supplies measured evidence. Select real providers if you later add agent collection or LLM grading." : "Name the interface to inspect in the scenario and rubric. Put executable tests, builds, and type checks in explicit command graders; workspace agents can only list, read, and search."}

Add .agent-eval/ to your project's .gitignore; it contains retained evidence and
private browser sessions. Keep credentials out of fixtures and variables.

Document and perform your test-state preparation: seed required records, confirm
account roles and integrations, and reset state before each independent run.
A fresh browser context does not reset backend data. target.setup can run an
explicit preparation command once per new run; successful setup is skipped on
resume. There is no automatic application-data cleanup. HTTP readiness alone
does not prove accounts, permissions, or fixtures are ready.

## 2. Author one measurable requirement

Edit evals/specs/core.yaml, following this chain:

| Part | Write down |
| --- | --- |
| Claim | One behavior and its exact expected result |
| Exercise | Fixed inputs and actions that expose that behavior |
| Evidence | Actual values, screenshots, or source references needed to decide |
| Grader | Deterministic command, evidence-based LLM, manual, or hybrid |

For example: two items at 500 cents must total 1000 cents. Exercise quantity two;
retain actual and expected totals; use a deterministic checker. A persistence
claim additionally needs reload/restart evidence. Source agreement can use file
references, but source inspection cannot prove that runtime behavior succeeded.

Replace all example wording, and remove criteria that do not apply. Keep area
weights totaling 100. Add human review only when a person must supply evidence;
manual work remains unavailable until finalized. Mark only mandatory items as
gates. For extra command graders, declare output: json or output: exit-code.
JSON graders exit 0 and emit a schema-valid verdict; unexpected execution errors
must fail the run rather than masquerade as uncertainty or product defects.

## 3. Validate and pilot

From the project root:

\`\`\`bash
aek validate
aek doctor
aek list
aek run --dry-run
aek run
\`\`\`

Validation checks contracts and paths, not whether your rubric is useful.
Doctor checks local tooling/authentication, not provider quota. Open the printed
report.html and inspect the evidence for each verdict. Correct collection gaps
before adding more scenarios. Score measures judged performance; coverage
measures how much could be judged. Blocked or insufficient evidence reduces
coverage; provider/checker failures are execution errors.

For a guided whole-project survey or help extending this kit, install the
AEK authoring skill with aek author install and ask your coding agent to use
$aek-author. Decisions and requirement links persist in .aek-authoring/plan.json;
aek author status reports inventory progress separately from evidence coverage.

## 4. Calibrate on good and broken behavior

Use a disposable test target. Choose a known-good implementation and write down
the expected item verdict, coverage, and gate result BEFORE running it.

1. Finish the evaluator definition and prepare clean test state. Run aek run.
   Record the printed run directory as the good run and review its evidence.
2. Introduce one deliberate target defect that violates the chosen requirement:
   ignore quantity, omit a saved field, contradict a documented interface, or
   clip a required label. Keep specs, fixtures, providers, scoring, checker and
   collector code, and their dependencies fixed.
3. Reset to equivalent test state and start a NEW aek run. Do not resume the
   good run. Confirm the intended rubric item fails with observed evidence,
   coverage stays comparable, and its critical gate blocks the run (exit 2).
4. Compare the two runs, replacing the paths below:

\`\`\`bash
aek compare --baseline /path/to/good-run --candidate /path/to/broken-run --fail-on-regression
\`\`\`

The comparison should report the intended regression and exit 2. Exit 1 means
an execution error, not a detected product defect. A blocked scenario, withheld
score, or lost coverage is not evidence that the checker detected the defect.
If calibration misses the defect, improve the exercise/evidence/rubric and rerun
BOTH targets with the new evaluator. Comparisons require matching evaluator
fingerprints. Declare the checker, its dependencies, configuration, and expected
results in methodFiles, excluding the product implementation. These files are
snapshotted and hashed as evaluator inputs; changing them makes comparisons
incompatible. AEK does not infer imports, so review that the list is complete.
Repeat LLM trials when assessing variability; one pair is a smoke
check, not a judge-accuracy estimate.

Restore the good target, reset state, and run aek run --split all. The default
release promotion policy requires the complete required suite, split all, 100%
coverage, and passed gates. If you configure a different promotion policy, use
its required split and thresholds. Finalize required manual reviews, then:

\`\`\`bash
aek baseline promote --run /path/to/restored-good-run --name main --reviewer YOUR_NAME
\`\`\`

## Completion checklist

- [ ] Target, accounts, fixtures, and reset procedure are documented and working.
- [ ] Every criterion has an explicit exercise, expected result, and evidence.
- [ ] A reviewed good run has sufficient coverage and passes mandatory gates.
- [ ] A deliberate defect produces the expected observed failure and regression.
- [ ] Required manual reviews are finalized before baseline promotion.
- [ ] The restored good run is reviewed and promoted as the baseline.

Then expand to more workflows and case matrices. Keep evaluation-split cases
reserved for evaluation; ordinary runs default to the development split.
`;
}

export function initializeProject(directory: string, requestedKind: string = "web"): string[] {
  const kind = STARTER_KINDS.find((candidate) => candidate === requestedKind);
  if (!kind) {
    throw new Error(`Unknown starter ${requestedKind}; expected ${STARTER_KINDS.join(", ")}`);
  }
  const root = path.resolve(directory);
  const files: Array<{ target: string; content: string; staged?: string }> = [
    { target: path.join(root, "evalkit.yaml"), content: configTemplate(kind) },
    {
      target: path.join(root, "evals", "specs", "core.yaml"),
      content: authoringNotes + specs[kind],
    },
    { target: path.join(root, "evals", "fixtures.yaml"), content: fixturesTemplate },
  ];
  files.push({
    target: path.join(root, "evals", "ONBOARDING.md"),
    content: onboardingTemplate(kind),
  });
  if (kind === "command")
    files.push({ target: path.join(root, "evals", "check.mjs"), content: commandChecker });
  if (kind === "artifact")
    files.push({ target: path.join(root, "evals", "collect.mjs"), content: artifactCollector });
  const conflicts = files.filter(({ target }) => fs.existsSync(target)).map(({ target }) => target);
  if (conflicts.length) {
    throw new Error(`Refusing to overwrite existing files:\n  - ${conflicts.join("\n  - ")}`);
  }

  const published: string[] = [];
  const createdDirectories = [
    root,
    path.join(root, "evals"),
    path.join(root, "evals", "specs"),
  ].filter((directoryPath) => !fs.existsSync(directoryPath));
  try {
    // Stage every complete file before making any of them visible at its final path.
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      file.staged = path.join(
        path.dirname(file.target),
        `.aek-init-${process.pid}-${crypto.randomUUID()}.tmp`,
      );
      fs.writeFileSync(file.staged, file.content, { flag: "wx" });
    }

    // A hard link publishes without an overwrite race. Rollback below makes the
    // multi-file operation all-or-nothing from the caller's point of view.
    for (const file of files) {
      fs.linkSync(file.staged!, file.target);
      published.push(file.target);
      fs.unlinkSync(file.staged!);
      delete file.staged;
    }
    return files.map(({ target }) => target);
  } catch (error) {
    for (const file of files) {
      try {
        if (file.staged && fs.existsSync(file.staged)) fs.unlinkSync(file.staged);
      } catch {
        // Preserve the original initialization error.
      }
    }
    for (const target of published.reverse()) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {
        // Preserve the original initialization error.
      }
    }
    for (const directoryPath of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directoryPath);
      } catch {
        // Remove only directories that are still empty.
      }
    }
    throw error;
  }
}
