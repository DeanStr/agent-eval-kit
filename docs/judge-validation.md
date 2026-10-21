# Validate judges against reviewed evidence

`aek judge validate` compares configurations using the
existing `aek collect` / `aek judge` implementation. Collection happens once per
case. Each configuration receives the same pinned collection bytes in a separate
judging run. Setup, browser actions, collectors and command graders do not rerun.

```sh
aek judge validate --dataset cases.json --labels labels.json \
  --configurations configurations.json --output NEW_DIRECTORY
```

The output retains ordinary sealed judge runs, per-attempt diagnostics,
`validation-results.json`, `validation-results.html`, and separate reviewer-input
snapshots under `review/`. The HTML report shows reviewed evidence expectations
and known application outcomes separately, each configuration's decisions,
explanations, evidence links and previews, and aggregate metrics overall and by
split. Errors retain diagnostics without a decision; unattempted cases remain
visible in interrupted reports and do not enter metric denominators.
Reviewer citations are copied from the pinned collection into `review/evidence/`,
with source hashes recorded in per-case manifests. They remain distinct from
each configuration's replacement references and never enter judge inputs.
It refuses to overwrite an existing experiment. Exit 1 means an execution error
or invalid workflow input. Disagreement with reviewer labels is reported in the
metrics and does not itself change the exit status.
SIGINT and SIGTERM retain partial JSON/HTML reports and exit 130 and 143.
Use `aek judge validate --help` for the exact options. Source checkouts can also
use `pnpm judge:validate`.

The distributed package includes an offline example that needs no model login,
browser, or development dependencies:

```sh
node node_modules/agent-eval-kit/examples/judge-validation/run.mjs ./judge-validation-demo
```

It creates synthetic pass/fail/withheld collections, reviewed sidecars, and two
configurations, then invokes the installed CLI and writes the HTML report.
This demonstrates the workflow rather than model accuracy. See the
[example guide](../examples/judge-validation/README.md).

All candidate specs, referenced inputs, fixtures, and configuration files are
pinned before the first judge invocation and checked before and after each
attempt. Changing them during a comparison is an execution error; start a new
comparison to evaluate another configuration. Reviewer snapshots preserve the
exact input bytes and their recorded hashes.

## Inputs

All three files use strict JSON contracts with `version: 1`. Paths in the dataset
resolve relative to its file; configuration paths resolve relative to the
configuration manifest. Use an ordinary AEK YAML config for each candidate.
Candidates can change judge provider/model/effort, rubric wording, references and
scoring within the existing [detached judging contract](evidence-workflows.md).
Collection definitions and executable-check implementations must still match.
Selected criteria must use an automatic grader. Hybrid and manual criteria are
rejected before judging: pending manual work is not a model abstention. To assess
the automatic part of a hybrid check, author a separate automatic criterion and
review its labels. The decision-journal reader enforces the same restriction.
Case IDs, reviewer-label case IDs, and configuration IDs must be unique ignoring
ASCII letter case. This is enforced before creating output so attempt directories
and their diagnostics remain distinct on supported case-insensitive filesystems.

```json
{
  "version": 1,
  "cases": [{
    "id": "c01", "group": "same-application-and-mutations", "split": "development",
    "evidence": {"directory": "collections/example", "rootSha256": "<artifact root SHA-256>"},
    "area": "demo", "rubric": "GUIDANCE", "sources": []
  }]
}
```

Each case selects one item-level judgement. `sources` can pin maintenance reviews,
decision journals or other reviewer context using `{ "path": "...", "sha256": "..." }`.
An optional `originalRun` has the same directory/root contract as `evidence` and
links an earlier judgement without changing it or supplying it to the judge.
Historical combined runs need explicit extraction into a new collection; the
ProgramCue example demonstrates this using verified historical observations.

```json
{
  "version": 1,
  "labels": [{
    "caseId": "c01", "evidenceRootSha256": "<same artifact root SHA-256>",
    "area": "demo", "rubric": "GUIDANCE",
    "reviewer": {"name": "Reviewer name", "kind": "human"},
    "application": {
      "verdict": "fail", "rationale": "The independently observed candidate accepts before verification.",
      "sources": ["review or independent observation"]
    },
    "evidence": {
      "verdict": "cannot_judge", "rationale": "This package omits the recommendation.", "refs": []
    }
  }]
}
```

`application.verdict` is `pass`, `fail` or `unknown`; `evidence.verdict` is `pass`,
`fail` or `cannot_judge`. Evidence-supported decisive labels require references.
Keep reviewer identity, rationale and both outcomes in this separate sidecar.
Agent-authored assessments must say `kind: "agent"`; they are not human labels.
Label IDs must exactly match cases, and labels must pin the same collection root,
area and rubric. Repointing a case at another criterion requires a new review;
an earlier label cannot silently follow the case ID. Candidate prompt wording can
still vary while assessing the same intended requirement. Labels missing these
criterion fields are rejected, including historical comparison snapshots. Keep
old comparisons unchanged and start a new comparison with reviewed label identities.
Labels must live outside project roots, original runs and collection bundles.
They are never passed to the judge. Review notes, expectations and original
judgements also belong outside collected observations and judge instructions.

```json
{
  "version": 1,
  "configurations": [
    {"id": "original", "config": "project/judge-original.yaml"},
    {"id": "scoped", "config": "project/judge-scoped.yaml"}
  ]
}
```

## Rates and splits

Metrics use **evidence-supported labels**. A known application success or defect
does not establish a supported judgement when the necessary evidence is absent.
An execution error has `status: "execution_error"`, retained diagnostics, and no
verdict or score. A valid unavailable result has `status: "abstained"` and
`actual: "cannot_judge"`. Decisive results have `status: "judged"`.

Every metric supplies `count`, `denominator` and `rate`; zero denominators produce
`null` rates. `plannedObservations` also exposes interrupted/incomplete comparisons.

| Metric | Numerator | Denominator |
| --- | --- | --- |
| False passes | Pass on expected fail | All expected-fail attempts |
| False failures | Fail, partial or not_found on expected pass | All expected-pass attempts |
| Abstentions | Actual cannot_judge | All attempts |
| Execution errors | Failed executions, invalid results or integrity failures | All attempts |
| Decision coverage | Decisive judgements | All attempts |
| Unsupported decisions | Any decisive judgement on insufficient evidence | Expected cannot_judge attempts |
| Correct abstentions | Actual cannot_judge on insufficient evidence | Expected cannot_judge attempts |
| Exact matches | Actual verdict equals evidence label | All attempts |

Expected-pass/fail denominators include their abstentions and errors. Read error
rates and decision coverage alongside false-decision rates. An always-abstaining
judge has zero false decisions and zero decision coverage.

Cases require a related-example `group` and `development` or `evaluation` split.
Variants, evidence-withheld versions and other derivatives belong in one group.
The runner rejects groups crossing splits and identical evidence/original runs
assigned different groups. Reviewers must identify relationships beyond shared
hashes. Tune on development only; keep evaluation families held out. Metrics are
reported overall and separately for each split.

## Bounded exercises

For a twelve-case browser-persistence, exported-invoice and text-policy pilot,
including a separate review packet without judge predictions, see the
[packaged representative pilot](../examples/judge-validation/README.md#representative-pilot).
Its fixture labels are agent-authored. It reports abstentions, errors, unsupported
decisions and completed-run time separately; it establishes no general accuracy
or stability claim.

See the [runnable GUIDANCE and ProgramCue examples](../examples/judge-validation/README.md).
They reuse authoring maintenance notes under `.aek-authoring/reviews/` and the
improvement exercise's append-only decision journal. Judge validation does not
accept an application revision or replace the original model judgement.
Before journaling, the review helper validates the complete case/configuration
matrix, matches verdicts and evidence identities to the sealed judge reports,
checks error diagnostics and snapshot hashes, and recomputes all metrics. Each
journal entry pins the comparison file's SHA-256 and names the actual rubric.
