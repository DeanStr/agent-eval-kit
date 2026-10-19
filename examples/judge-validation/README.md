# Bounded judge validation

## Installed offline example

From a project with `agent-eval-kit` installed, run:

```sh
node node_modules/agent-eval-kit/examples/judge-validation/run.mjs ./judge-validation-demo
```

The destination must be new. This uses Node and the installed CLI, with no tsx,
browser, subscription login, or model calls. It creates three synthetic collected
command results (pass, fail, and withheld evidence), separate reviewer labels,
and two mock configurations. Command results are reused from each sealed
collection. The configurations therefore agree; this demonstrates the reporting
and validation contracts, not model accuracy. Open
`judge-validation-demo/comparison/validation-results.html` to review expectations,
decisions, reasoning, evidence previews, and metrics. Synthetic labels explicitly
record an agent reviewer. From a checkout, run `pnpm build`, then
`node examples/judge-validation/run.mjs ./judge-validation-demo`.

To rerun the installed command with edited configurations, use a new output:

```sh
aek judge validate --dataset judge-validation-demo/cases.json \
  --labels judge-validation-demo/labels.json \
  --configurations judge-validation-demo/configurations.json \
  --output judge-validation-demo/comparison-next
```

## Source-checkout exercises

Run from this source checkout with dependencies installed. Preparation uses the
existing collect-only runner; comparison uses detached judging. Real comparisons
require Codex subscription access; both preparations need Playwright Chromium.

## GUIDANCE

```sh
pnpm exec tsx examples/judge-validation/prepare-guidance.ts .agent-eval/experiments/judge-guidance
pnpm judge:validate --dataset .agent-eval/experiments/judge-guidance/cases.json \
  --labels .agent-eval/experiments/judge-guidance/labels.json \
  --configurations .agent-eval/experiments/judge-guidance/configurations.json \
  --output .agent-eval/experiments/judge-guidance/comparison
pnpm exec tsx examples/judge-validation/record-review.ts \
  .agent-eval/experiments/judge-guidance .agent-eval/experiments/judge-guidance/comparison
```

Preparation delegates to the improvement exercise's preparation and browser
collector. It selects only `demo/GUIDANCE`: original and equivalent valid wording,
an acceptance-before-evidence defect, that defect with unrelated seeded regressions,
and two evidence-withheld packages whose underlying applications have opposite
known outcomes. Only the current neutral target is collected. Withheld packages
contain a blocked scenario without the recommendation or screenshot.

The default candidates request `gpt-6-astra` with medium and high reasoning.
Edit candidates before comparing if necessary. All six cases share one development
family; mutation siblings cannot be presented as an independent evaluation set.
Labels are explicitly agent-authored, separate from the project and model outputs.

## ProgramCue

```sh
pnpm exec tsx examples/judge-validation/prepare-programcue.ts \
  /path/to/programcue .agent-eval/experiments/judge-programcue
pnpm judge:validate --dataset .agent-eval/experiments/judge-programcue/cases.json \
  --labels .agent-eval/experiments/judge-programcue/labels.json \
  --configurations .agent-eval/experiments/judge-programcue/configurations.json \
  --output .agent-eval/experiments/judge-programcue/comparison
pnpm exec tsx examples/judge-validation/record-review.ts \
  .agent-eval/experiments/judge-programcue .agent-eval/experiments/judge-programcue/comparison
```

This bounded historical review requires the retained local run
`evals/.agent-eval/runs/2026-09-06T11-59-52`. Missing or changed artifacts fail with
diagnostics. No application server, authentication, reset or sending is required.
The helper copies two actual version-history screenshots and the successful v1
PDF download from the verified historical run into declared collector sources.
The resulting collection records that these are historical observations, then
seals them through ordinary AEK collection. The companion package withholds the
checkpoint. Two additional synthetic HTML fixtures retain both PDF versions and
working downloads: a valid control marks v2 latest/current, while the defect marks
v1 latest/current. Playwright captures both participant and organizer views after
reload and verifies the downloaded bytes. Only marker placement changes between
the pair. Their synthetic provenance is explicit in the page and evidence; these
are contract fixtures, not reported defects in the live application. All four
cases stay in the same related evaluation family. Reviewer labels and fixture
expectations remain outside judge inputs.

The original model awarded partial credit to `PC-VERSION-HISTORY`, requesting
both PDF content checks and an individual v2 download. The application's existing
`evals/README.md` review and `docs/DECISIONS.md` separate visible history/current
markers from deterministic integrity checks. They supply the review context for
comparing the historical criterion with an explicit scope clarification. Both
candidates request `gpt-6-astra`, medium reasoning. The prior judgement is linked
by artifact-root hash and retained unchanged; its different provider/runtime and
evidence packaging prevent treating it as a matched candidate in this comparison.

No current ProgramCue or hosted-provider acceptance is claimed. The small,
agent-labelled set demonstrates the workflow, not general judge accuracy.
Independent human spot-checks and a larger evaluation set would strengthen the
assessment; human review is not required to run this example.

## Maintenance and decisions

Each preparation writes an initial bounded maintenance review using the existing
`.aek-authoring/reviews/` location and terminology. ProgramCue had no prior review
there; its existing evaluation notes and product decision log are reused as sources.
Dataset `sources` pin these reviewer records; they never enter judge prompts.

`record-review.ts` records attempts in `journal.ndjson` and calls the existing
improvement exercise `recordDecision` helper to append `decisions.ndjson`. It
records the bounded calibration decision as unresolved, with no application
acceptance and no score for errors. Reviewer kinds remain explicit; independent
review can strengthen the result without blocking execution. Original run reports
and judgements remain intact. Use a fresh experiment/output directory for another run.

The recorder verifies summary observations against sealed reports and retained
errors, checks the reviewer snapshots and complete attempt matrix, and recomputes
the metrics before appending anything. Entries retain the real rubric ID and pin
the comparison summary by hash. Candidate inputs are frozen for the duration of
each comparison; edits require a new comparison directory.

The file contracts and denominators are in [judge validation](../../docs/judge-validation.md).

## Exercise results: 19 October 2026

These historical comparisons predate the required area/rubric binding in reviewer
labels. Their artifacts remain unchanged; the current journal reader rejects
those older label snapshots. New preparation includes the required fields. Review
the label identities and use a new comparison directory for subsequent runs.

The [recorded result summary](results-2026-10-19.json) pins collection roots,
label-file hashes, evaluator fingerprints and requested provider settings. The
live runs used Codex CLI 0.163.0 with requested `gpt-6-astra`; source bundles and
full diagnostics remain under the experiment paths recorded in that summary.
All completed comparisons had zero execution errors and no unsupported decisions.

| Configuration | False passes | False failures | Abstentions | Execution errors | Decision coverage |
| --- | --- | --- | --- | --- | --- |
| GUIDANCE medium | 0/2 | 0/2 | 2/6 | 0/6 | 4/6 |
| GUIDANCE high | 0/2 | 0/2 | 2/6 | 0/6 | 4/6 |
| ProgramCue historical wording | 0/0 (unavailable) | 0/1 | 2/2 | 0/2 | 0/2 |
| ProgramCue explicit scope | 0/0 (unavailable) | 0/1 | 1/2 | 0/2 | 1/2 |

Both GUIDANCE configurations passed the two valid variations, failed the two
observed defects, and abstained on both withheld recommendations. In ProgramCue,
historical wording abstained on the observed checkpoint because it requested
proof of distinct PDF contents and successive uploads; explicit scope passed
the supplied history/current/accessibility evidence. Both abstained when the
checkpoint was withheld. This illustrates a coverage difference without a false
failure: the original wording made no decisive decisions. ProgramCue has no
known-defect case in this bounded set, so false-pass sensitivity is unmeasured.

The scope clarification was authored from the pre-existing application decision
before comparing either candidate; the evaluation cases were not used for tuning.
These observations do not justify a claim of general judge superiority or accuracy.
Both comparisons were recorded through `record-review.ts`; decisions remain
unresolved for independent label review. The original historical partial judgement
and its artifact root were verified unchanged after the exercise.

## ProgramCue defect comparison: 19 October 2026

The subsequent [retained comparison](results-programcue-defect-2026-10-19.json)
uses four reviewed cases and the required area/rubric label identities. It keeps
both judge criteria unchanged and adds the synthetic control/defect pair above.
The experiment is `.agent-eval/experiments/judge-programcue-20261019-defect`;
`labels.agent-reviewed.json` records the reviewed expectations and
`comparison/validation-results.json` retains all eight attempts.

| Case | Expected | Historical wording | Explicit scope |
| --- | --- | --- | --- |
| p01: historical history and v1 access | pass | cannot_judge | pass |
| p02: withheld checkpoint | cannot_judge | cannot_judge | cannot_judge |
| p03: synthetic control, v2 latest/current | pass | cannot_judge | pass |
| p04: synthetic defect, v1 latest/current | fail | fail | fail |

Both configurations caught the seeded defect: false passes are now 0/1 for each.
Historical wording had 1/4 decision coverage and 2/4 exact matches; explicit scope
had 3/4 decision coverage and 4/4 exact matches. Both had zero execution errors,
false failures (0/2), and unsupported decisions (0/1). Historical wording
abstained on the valid examples because it requested proof of the upload workflow
beyond this bounded visible-history/accessibility contract.

The result establishes detection of this one controlled marker defect. All four
cases belong to one related family, labels are agent-reviewed, and synthetic
fixtures do not establish live ProgramCue behaviour. The sealed report reader
verified all attempts and the comparison was recorded in the decision journal.
The original historical run remains unchanged.
