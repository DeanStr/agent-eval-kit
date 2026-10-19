# Generate and calibrate a suite

Use this after the scope and individual acceptance contracts are sufficiently
clear. Start with the most consequential workflows, keeping the remaining project
inventory visible. Don't wait for every area's question to be answered before
validating independent areas.

## Choose the evidence and check

| Requirement | Collection | Grader |
| --- | --- | --- |
| A user completes a web workflow | Browser scenario with explicit actions and reached evidence | `llm`, or command checks for exact observable values |
| A documented interface matches source | Read-only workspace scenario | `llm` limited to source claims |
| CLI output/calculation/API response is exact | Existing relevant tests or a project-owned checker | `command`, explicit JSON/exit-code contract |
| Image readability/completeness | Browser capture or command collector | Ordinary `llm` absolute criterion |
| Image preference/non-regression | Collected candidate plus reference files | `pairwise` |
| Repeatability/motion/image measurements | Controlled capture, or applicable diagnostics | `capture`, `image-distinctness`, `image-regression` |
| Writing preference/voice | Direct local text or dataset | `text-pairwise` |
| Text meets policy/preserves supplied facts | Direct named text inputs | `text-rubric` |
| Exported/downloaded file correctness | File evidence plus project-owned parser | `command` |
| Human-only requirement | Explicit review instructions | `manual` or weighted `hybrid` |

For full field contracts use AEK's packaged docs. Installed copies are `docs/` and `README.md` relative to this reference file's
directory. From the source skill use the package's root `docs/` and `README.md`. Read only the
relevant guide: `workflows.md`, `file-evidence.md`, `email.md`, `text-evaluation.md`,
`visual-evaluation.md`, or README's configuration, specs, and grader sections.
The artifact/image and specialized format paths can need project-owned extraction.
For a one-off pair of existing images, use `aek image compare --candidate file --reference file --criterion text`; add `--absolute-criterion` for a candidate-only quality gate. For project suites, generate collection and rubric definitions. Don't imply built-in PDF/video/spreadsheet semantics.

## Reuse existing tests

Before writing a checker, inspect existing tests, assertions, fixtures, and runner
commands for the agreed requirement. Reuse tests that exercise the relevant behavior;
add assertions only for gaps. A passing unit test does not establish an unexercised
browser or integration workflow. AEK runs explicitly configured commands; it does
not discover tests or map individual test results to rubrics automatically.

Select the relevant tests for a requirement. One command grader produces one rubric
verdict; a whole suite can serve as an aggregate regression check. Avoid running and
scoring the same whole suite separately for each requirement.

Check the runner's result contract before using `output: exit-code`: AEK interprets
codes 0–4 as verdicts, including 1 as `fail` and 2 as `partial`. If the runner reuses
those codes for setup errors, wrap it with a small project-owned JSON adapter that
reads its structured results. Reuse the assertions; translate only the results.
Validate completion status, selected tests, and structured results from the current
invocation before assigning a verdict. Use a fresh report path or remove the
adapter's previous report before launch. Invalid selection with no matching tests,
missing/malformed results, setup failures, signals, and timeouts are execution errors
even when some assertions were reported. For a valid execution, return `fail` for
observed product assertion failures and `pass` only when the required tests executed
and passed. Required skipped tests cannot establish a pass; use `cannot_judge` with
a reason when valid missing evidence prevents a verdict. Skips caused by broken
setup remain execution errors. Do not infer success from an empty failure list.

In JSON mode the adapter exits 0 for any valid verdict, including `fail` and
`cannot_judge`; execution errors exit nonzero. Keep stdout to the single AEK JSON
object and retain runner diagnostics in stderr or run artifacts. Declare the tests,
adapter, and grading dependencies in `methodFiles` as described below. Verify the
integration on a passing case, an assertion failure, and a runner error; check
skipped/no-match behavior if the runner supports it. When reading report files,
verify that a stale passing report cannot mask a failed new invocation.
For a runnable Node.js example and its YAML connection, read `existing-tests.md`
in the packaged docs located as described above.

## Build the definitions

For a new kit, `aek init --kind web|repository|command|artifact` generates an
editable starter. Choose a kind consistent with the target; artifact is a starter,
not a target kind. Existing kits must be extended without overwriting files.
Scenarios may be browser/workspace/command subject to target compatibility; direct
text, command, and manual rubrics do not require placeholder scenarios.

One YAML file represents a weighted area; required area weights total 100. Propose
weights based on the agreed product priorities. Rubric weights are relative within
an area. `gate: true` requires a full pass regardless of aggregate score; confirm
its release importance rather than marking everything critical. Numerical score
and coverage thresholds also need a reason tied to the intended decision.

Every referenced scenario must belong to its rubric's area. Cross-area scenario
dependencies and typed outputs/inputs enable shared workflows. Reuse case IDs,
strata, and split across dependent matrices. Use explicit case variations for
agreed roles/states; don't treat one happy path as proof of every variant.

Command graders and collectors declare all method scripts/dependencies/expected
files in `methodFiles`, excluding the product implementation. Execute the actual
target and compare to an independent expectation. A mismatch produces a product
verdict; an import failure, timeout, malformed output, or missing required input
is an execution error. Use mock providers only for truly deterministic paths;
never manufacture model evidence or claim quality from a mock pilot.

Keep fixture identities non-secret. Capture browser sessions for authentication.
Specify preparation/reset and cleanup for stateful targets; browser isolation does
not reset application data. Confirm environment identity before actions that can
send email, charge money, delete records, or otherwise affect a live service.
Reuse authorization already given; an eval-authoring request does not itself
supply credentials or permission to mutate a production system.

## Verify progressively

1. `aek validate --config <file>` checks config, specs, and declared files.
2. `aek run --config <file> --areas <ids> --dry-run` checks the proposed selection.
   Use `--split all` for a full inventory preview; normal runs default to development.
3. `aek author validate --project <root> --json` checks the map and its rubric links.
4. `aek doctor --config <file>` checks installed providers and browser tooling.
5. Run authorized, bounded pilots with the pinned config and inspect report evidence.

A map can be structurally valid while discovery is still incomplete. Use
`aek author validate --require-ready` when enforcing readiness of the reviewed
inventory; exit 2 means remaining work, not invalid JSON or an execution failure.

## Review the pilot

Read execution status, coverage, critical gates, and `areas[].items` in
`report.json`, then follow the evidence for failures and representative passes.
Command-grader failures can exist while `areas[].defects` is empty. Inspect
unexpected passes as well as failures; a higher score does not clear a failed gate.
When several items fail, check whether they describe the same underlying defect.

Distinguish an observed product failure from a collector/checker mistake, an
unsupported judge interpretation, or a missing requirement. Correct execution
problems before scoring the product. If examples expose an unsettled expectation,
record it in the project map and ask only about the unresolved product decision.
Revise criteria when supported by the intended contract, not merely to make the
current target pass. Keep brief review notes and evidence links in `.aek-authoring`,
identifying agent assessments separately from actual user judgments. An ordinary
pilot does not require a new annotation tool or statistical validation workflow.

## Calibrate on known outcomes

For each linked check, write why the baseline target should pass and identify a
specific defect it should reject. Use an isolated target copy or test environment.
Record expected outcomes before running, then compare with actual results. For a
cart example, preserve the correct checker and change only the target to ignore
quantity. The good run should pass,
the defective run should fail the intended item, and evidence coverage should
remain complete for that check. A crash or blocked login is not detection.

For important checks, choose a defect that could plausibly escape the evaluator,
and a valid variation it might wrongly reject. For example, keep correct status
labels but introduce contradictory next-action guidance; separately try equivalent
correct wording. Valid variations may change wording or implementation only where
the contract permits. Leave the evaluator and selected cases fixed across trials.
Scale these trials to the risk and authorized budget;
do not require a large labeled dataset for every check. Record passing variations
as good trials with their rationale, and retain disagreements in review notes.

Keep the evaluation method and selected cases fixed across each pair. A changed
checker/reference/spec/provider setting requires both trials with that revised
method. AEK verifies retained artifacts and fingerprints. Restore the good target
after the experiment; do not alter the real product to satisfy the eval. Record
trial paths and rationale in the plan, then rerun author status. Each linked check
needs its own good/pass and defect/fail evidence to reach the calibrated stage.

If real evidence cannot be produced, leave the stage configured, retain the
specific blocker, and complete unrelated work. For remote targets whose identity
cannot be distinguished in receipts, status cannot verify a changed target: keep
it exercised and record the limit rather than fabricating a calibration claim.

Release promotion is separate. Default policy requires the full required suite,
split all, 100% coverage, and passed gates; honor configured policy and finalize
required manual reviews. Repeated judge agreement measures consistency, not truth.

## Updating a project

For a maintenance review, follow [the maintenance workflow](maintenance.md) and
start a [review note](../templates/review-note.md). Survey current interfaces as
well as revision changes, and carry forward unfinished work.

Read the map and run status at the beginning of the next session. Preserve exact
answers and stable IDs; append new decisions/requirements and reopen affected
questions when the user changes intent. Track gaps at project level while working
one area at a time. Review existing unmapped checks before changing them. When
an evaluator changes, move superseded trial references/rationale to authoring
history and collect new trials for the active definition. Updating the authoring
record itself must not change target or evaluator identity.
