# Marketing demo improvement exercise

This exercise evaluates the real interactive page in `docs/marketing/index.html`
in an isolated copy. Two command graders check executed browser state; a live
Codex judge checks whether the unverified revision's next-action guidance requires
evidence before acceptance. The collector uses Playwright directly. `agent: mock`
does not fabricate observations or judgments: no scenario model is required for
this deterministic collector, and the semantic judge uses a real subscription.

The suite covers selected documented behaviors, not the whole website. Expected
outcomes are agent-authored from the documentation and authored scenario data,
not independent human labels or an estimate of judge accuracy.

## Prepare and run

Run from the AEK source checkout with dependencies installed, Playwright Chromium,
and Codex subscription authentication. The generated config pins `gpt-6-astra`;
choose an available judge before the first run and retain that configuration for
all comparisons. AEK's dependency preview cannot infer Chromium usage inside a
project-owned command collector.

```sh
pnpm aek doctor --providers codex
node examples/improvement-exercise/prepare.mjs
pnpm aek validate --config .agent-eval/experiments/marketing-improvement/project/evalkit.yaml
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement original
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement equivalent
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement guidance
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement accepted
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement pending
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement combined
```

Each `run.mjs` command executes one live model judgment. Runs are sequential:
the project target is replaced before each run. Passing targets exit 0; observed
gate failures exit 2; execution errors exit 1. Inspect every result rather than
chaining expected failures with `&&`. The original marketing page is never edited.
Preparation refuses to overwrite an existing exercise. To repeat from scratch,
pass a new output directory under this checkout's `.agent-eval/experiments/` to
`prepare.mjs`, then use that directory in subsequent commands. The copied
collector resolves Playwright through this checkout's installed dependencies.

`expected.json` records anticipated verdicts before evaluation. It and the named
variant files live outside the evaluated project. Only the currently selected
HTML is snapshotted and exercised. `journal.ndjson` records actual runs, target
hashes, evaluator fingerprints, verdicts, coverage, and exit statuses. Avoid
editing either sealed run artifacts or the evaluator between comparison runs.
If the CLI fails before creating a run, the journal records `run: null` and the
failure status; the CLI output contains the original diagnostic.

## Inspect and improve

Read `report.html` and the individual item reasoning in `report.json`. Follow
evidence links to actual browser states and the inspector screenshot. Check that
the bad-guidance variant fails despite having correct numbers and an UNVERIFIED
badge, and that equivalent guidance passes despite different words.

After the combined variant, edit only the isolated
`project/site/index.html` using the observed failures as feedback. Keep the
suite and collector fixed. Evaluate those edits without replacing them:

```sh
node examples/improvement-exercise/run.mjs .agent-eval/experiments/marketing-improvement current
pnpm aek compare --baseline /path/to/combined-run --candidate /path/to/repaired-run --fail-on-regression
pnpm aek verify --run /path/to/repaired-run
```

Partial improvements may still exit 2: all three criteria are critical gates.
A score increase does not authorize acceptance while another gate fails.

Record each improvement decision with the project-owned helper:

```sh
cp examples/improvement-exercise/decision.example.json /tmp/aek-decision.json
# Edit the hypothesis, change, 1-based journal line numbers, comparison paths,
# outcome (accepted/rejected/unresolved), and reason using the actual evidence.
node examples/improvement-exercise/record-decision.mjs .agent-eval/experiments/marketing-improvement /tmp/aek-decision.json
```

`decisions.ndjson` links hypothesis → concrete change → journal attempts and AEK
comparisons → outcome → reason. It snapshots the referenced journal entries and
comparison reports with hashes, preserving target/evaluator provenance and errors.
Append another record with the same decision ID to resolve or revise a decision;
the new record links the previous record's hash. Nothing is overwritten or
automatically promoted. For a failed execution, keep `comparisons: []`, link the
failed attempt, and explain the unresolved or rejected decision without a score.
Comparison snapshots must match the linked journal runs' evaluator, score, and
coverage. Acceptance requires a compatible comparison whose candidate completed
successfully with full coverage, a visible score, and passed gates. Earlier failed
attempts can remain linked as history; they do not support acceptance. Legacy
entries without gate evidence need a fresh run before acceptance. The reviewer
still checks the actual product evidence and reason for the change. Hypotheses
and decisions are review records, not another feature map or an optimiser.

The map in `project/.aek-authoring/plan.json` can retain good and defect run
references per check. `aek author status` verifies them. Its scope deliberately
has no `reviewedBy`: the exercise must not invent a human's review of its chosen
inventory. Calibration of individual checks can be established while overall
authoring readiness remains false for that reason.

## Collection boundary

The collector copies AEK's sealed, extensionless source snapshot to `render.html`
inside its output directory before opening it. Otherwise Chromium renders the
snapshot as plain text. It executes the copied HTML, selects actual controls,
and uses a controlled browser clock for playback. It never reads the mutable
target or the experiment's expected outcomes to produce evidence.

The command grader verifies the recorded file's checksum and compares observed
fields with fixed expectations. Browser, collector, or evidence errors fail
execution; they are not converted into product failures. Collected observations
remain project-owned instrumented claims, not independent proof that the
collector itself is correct.
