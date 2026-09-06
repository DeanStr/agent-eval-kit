# Collect evidence once, judge it separately

`aek run` remains the combined collection and judging command. For expensive
browser captures, artifact extraction, or judge calibration, separate the phases:

```bash
aek collect --config evalkit.yaml --split all
# Use the collection directory printed by the command.
aek judge --evidence .agent-eval/runs/<collection-id>
aek judge --evidence .agent-eval/runs/<collection-id> --judge claude
```

Collection executes target setup/start/readiness, selected scenarios, and command
graders, then shuts down the target and seals the bundle. It does not invoke a
model judge, produce a quality score, or enforce rubric release gates. Successful
collection means the evidence workflow completed; observed check failures and
blocked scenarios remain in the bundle. Execution errors fail collection.

A completed collection has `collection.json`, exact spec/config snapshots,
`receipt.json`, scenario artifacts, collected command results, and an integrity
index. Prerequisite-only areas explicitly record empty command results, so later
model rubrics can reuse their collected evidence when the collection contract matches.
Selected-suite snapshots retain their original area weights and do not need to sum
to 100; full project suite validation still requires that total.

It is immutable: use `aek collect --resume <directory>` only to recover an
unfinished collection. A completed collection cannot be resumed into new target
state or promoted as a scored baseline.

Each `judge` invocation creates a separate run under `paths.runs`, copies and
verifies the collected bytes, and records the source collection's ID, artifact
root hash, and collection-definition hash in its receipt. Copies are ordinary
files, not writable links into the source bundle. Reports, model output and vote
journals belong to the new run; the original collection remains unchanged.
Detached judging does not start the target, run setup, execute a collector or
rerun command graders. Command results are observations from collection time.
Malformed collected results or a mismatch with the command rubric abort judging;
they never trigger command execution.
The target identity and collection runtime remain those recorded at collection.

Without `--config`, judging uses the sealed definitions and reference snapshots.
Resolved configuration values are read literally without loading a new environment.
The original configuration, target server, checker, source artifacts and reference
files are not needed. The configured judge CLI must be available if that grader
uses a real provider. Override its provider/model with `--judge` and `--judge-model`.
Before model judging, saved hashes verify that instructions, project context and
judge settings were not altered by redaction. If they differ, judging requires
an explicit `--config` with the original values; it never executes redacted
substitutions as evaluator instructions.

## Calibrate judging against fixed evidence

```bash
# Edit rubric criteria, weights, gates, reference images, or judge settings.
aek judge --evidence .agent-eval/runs/<collection-id> --config evalkit.yaml
```

An explicit configuration may change model judging criteria, add model rubric
items over existing scenarios, change references, or change scoring. Its scenario
and executable-check definitions must match the collection. The target, collection
agent, browser policy, project variables/instructions, fixtures and executable
checker implementation must also match. Changing these requires fresh collection.
The set of materialized areas/scenarios and the collection split remain fixed.
An explicit config uses the original collection's selected areas; other areas in
that project remain outside this judging run.
Candidate text declarations remain fixed; reference text can change.

The explicit config path validates current fixtures and checker files, and resolves
and snapshots new references. Candidate artifacts still come from the collection,
even if the current project has changed. New rubric criteria do not establish new
facts: absent ordinary evidence becomes `cannot_judge`; undeclared controlled image
labels and malformed contracts fail before judging. Add a scenario or capture
checkpoint and recollect when a new requirement needs evidence that was not gathered.

Evaluator compatibility and evidence identity are separate. Receipts preserve the
original collection-method hash and record the later judge CLI and image-processing
runtime separately. Changing judging
policy changes the evaluator fingerprint, so ordinary comparisons with the old
policy are incompatible unless explicitly allowed for exploratory analysis.
Different target collections judged using the same method can be compared normally.
Reusing evidence requires its saved collection-method hash and judging runtime;
missing provenance is an error and is never reconstructed from the current environment.

## Recovery and review

```bash
aek judge --resume .agent-eval/runs/<interrupted-judging-id>
aek verify --run .agent-eval/runs/<judging-id>
aek rescore --run .agent-eval/runs/<judging-id>
```

Resume requires unchanged source evidence and judging inputs. Sealed completed areas
and completed votes are reused, while incomplete judge output is recovered. A new judge or rubric needs a
new judging run. `rescore` remains an offline change to permitted scoring fields;
it does not call a new judge. Manual review/finalization and report exports work on
the resulting judging runs just as they do on combined runs.

For detached judging runs, `rescore` and `finalize` default to that judging run's
own sealed config and spec snapshots. The original project files and collection
directory are not needed. Missing or corrupted snapshots fail immediately.
Use `--config evalkit.yaml` to request current definitions; the existing scoring
and judgement-compatibility checks still apply. Successful detached rescoring
publishes the effective config and specs under `scoring-definitions/` in the same
recoverable update as its report and receipt. Later default rescore/finalize uses
those recorded definitions, so accepted weight or scoring changes are retained.
The original `inputs/` snapshots stay unchanged. A receipt naming effective
definitions requires those exact files; missing files never select the originals.

Receipts distinguish resolved and redacted config representations and retain
full-value compatibility hashes separately. An unchanged original config remains
compatible with a redacted snapshot, while actual secret changes still fail. Release promotion continues to
check the current declared suite rather than substituting the run's selected specs.

## Baseline promotion policy

Baseline promotion defaults to `release` mode. It verifies run integrity and requires
all declared required scenarios to have been exercised, required gates to pass,
and the configured coverage/score limits to hold. Failed or unavailable gates
block promotion. Blocked or omitted scenarios do not establish completeness;
observed `feature_not_found` counts as exercised, with acceptance determined by the
rubric gates and score policy.

Expected scenarios and rubric items come from the project's full configured spec
suite, not the run's `--areas` or `--scenarios` selection. The run split must match
the promotion split; an `all` run cannot substitute for an evaluation-only run. Spec bytes must still match
the evaluated definitions, including prerequisite-only areas that contribute no
score in the selected split. The default policy requires all splits, excludes optional
areas, and requires 100% evidence coverage. Customize it in `evalkit.yaml`:

```yaml
promotion:
  split: evaluation           # all (default), development, or evaluation
  includeOptional: false
  minimumCoverage: 100
  minimumScore: 85             # optional; critical gates always apply
```

```bash
aek baseline promote --config evalkit.yaml --run "$RUN" --name main --reviewer dean --include-images
```

Coverage and score thresholds apply to the policy-selected areas, including optional
areas when `includeOptional: true`.

A withheld headline score blocks release promotion. All checks run before creating
or moving a baseline pointer. Policy rejection exits with status 2; invalid inputs
or execution errors exit with status 1. The promotion snapshot records the policy and expected
suite identities along with its source hashes and reviewer.

For an intentionally reviewed intermediate result, choose a distinct baseline name
and explicitly record the exception:

```bash
aek baseline promote --config evalkit.yaml --run "$RUN" --name milestone --reviewer dean \
  --mode milestone --reason "Reviewed the initial rendering milestone" --include-images
```

Milestone mode bypasses release gates, coverage and suite completeness checks. It
still requires a complete scored run with intact artifacts and a non-empty reason.
The mode and reason are hashed into the promotion metadata. There is no automatic
promotion or implicit fallback from release mode to milestone mode.

Detached-run promotion requires `--config <current-project-config>` so release policy,
suite definitions, and baseline destination are explicitly current, rather than read
from a collection snapshot. This also applies to milestone promotion.

Receipt top-level runtime fields retain the collection's Node, platform, architecture,
and kit version. `runtime.judging` records these values separately for actual judging;
rescoring and finalization preserve both runtimes.

## Preparing state for repeated runs

Every new campaign repetition invokes the configured `target.setup` before target
startup/readiness and evidence collection. Use it to reset and seed a disposable
database or a dedicated test tenant. Existing authenticated sessions must remain
valid after seeding; preserve their test accounts or capture fresh personas first.

```yaml
target:
  kind: web
  url: http://127.0.0.1:3000
  setup:
    command: node evals/reset-and-seed.mjs
    timeoutSeconds: 120
  start:
    command: npm run start:test
  ready:
    url: http://127.0.0.1:3000/health
```

Setup receives `AEK_PROJECT_ROOT` and `AEK_RUN_DIR`. Each run retains stdout/stderr
and `lifecycle/setup.json`, recording the command, working directory, timestamps,
and success/failure. Process failures and timeouts abort that repetition before
collection. Campaigns retain failed repetitions; a later repetition starts its
own setup. A successful setup record is sealed before later lifecycle failures
can interrupt the run. Resume skips only sealed successful preparation; failed
or interrupted setup runs again, so reset scripts should tolerate partial prior
execution. Refreshing setup must not mutate evaluator specs or expected data.
Saved setup records are validated before this decision. Missing/unknown statuses,
malformed records, and contradictory success/failure fields abort resume without
rerunning setup.

Setup success proves that the command completed, not that external data was reset
correctly. Include deterministic checks for the intended initial state. When
resetting is unavailable, use an isolated tenant per run and keep state-dependent
campaign measurements distinct from independent repetitions. AEK does not inject
an implicit reset or infer one from a setup command name.
