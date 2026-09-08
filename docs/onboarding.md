# Onboarding your project

Onboarding produces a project-owned evaluation definition and evidence that it
can distinguish a working requirement from a deliberate defect. `aek init`
writes templates; it does not discover your architecture or invent requirements.

For agent-assisted discovery and generation, use the [project authoring skill](authoring.md).
It supports whole projects and individual features, records decisions across sessions,
and validates generated checks. The steps below describe manual setup.

## Choose a starter

Install the [built package](../README.md#built-package-distribution) or link the
source checkout using the [quick start](../README.md#quick-start), then run one of
these in your project's root. For a local npm install, replace `aek` with `npx aek`;
for a local pnpm install, use `pnpm exec aek`.

| Command | Starting evaluation | Required customization |
| --- | --- | --- |
| `aek init --kind web` | Browser workflow with a persistence gate | URL, exact screens/fields, expected values, test data and authentication |
| `aek init --kind repository` | Documentation/source agreement for a named interface | Interface, documented contract, implementation paths |
| `aek init --kind command` | Deterministic output/exit-status check | Implement `evals/check.mjs` and specify the invocation and expected result |
| `aek init --kind artifact` | Readability of a delivered PNG | Source PNG path, required content, viewing size |

An optional positional directory chooses the destination. Omitting `--kind`
selects `web`. Existing destination files are never overwritten; all generated
files are preflighted before publication, including the guide and helper scripts.

Every starter contains `evalkit.yaml`, `evals/specs/core.yaml`,
`evals/fixtures.yaml`, and `evals/ONBOARDING.md`. Command and artifact starters
also include their helper script. Artifact evaluation uses a repository target
and a command collector; `artifact` is a starter choice, not a new target kind.
The PNG must exist before validation. The command checker deliberately raises
an actionable error until implemented, preventing an unconfigured check from
reporting a fabricated success. The command starter uses offline mock providers
and a placeholder scenario; all measured evidence comes from its real checker.
It needs no provider login. Select real providers if you add agent collection or
LLM grading. Artifact collection also needs no agent subscription, but its image
judge uses the configured real provider. The PNG collector checks the source
signature before copying; other formats require explicit extraction and updated
provenance.

## Define the first requirement

Follow the generated guide and replace every example assumption. Write one
claim, an exercise that exposes it, the evidence needed to decide, and a grader.
For example, a quantity-two CLI calculation must return 1000 cents for a
500-cent unit price. Execute the command and compare with the independent
expectation of 1000; retain the actual result in the grader's reasoning.

Use deterministic checks for exact values and exit statuses. Use LLM judgements
for interpreting collected evidence. A source-level requirement can cite code;
a runtime or persistence requirement needs execution evidence. Workspace agents
can list, read, and search; put executable checks in explicit command graders.

Configure account roles, fixture records, and any integrations before the run.
Capture browser authentication with `aek auth` and mark authenticated scenarios
with `persona` and `requiresAuth`. Document how to reset application data between
runs: browser isolation does not reset a database. `target.setup` can run a
preparation command, but AEK does not automatically clean up application data.
Keep `.agent-eval/` out of source control.

Run `aek validate`, `aek doctor`, `aek list`, and `aek run --dry-run`, then run a
small pilot with `aek run`. These checks establish valid configuration and local
tooling; they do not establish evaluation quality. Review the report's evidence,
score, coverage, and critical gates separately.

## Prove the evaluation detects a defect

The generated guide contains a calibration procedure and commands:

1. Write down expected results for one known-good requirement; prepare clean
   test state, run the evaluation, and inspect its evidence.
2. Change only the disposable target to violate that requirement. Keep the
   evaluator definition, fixtures, providers, scoring, checker/collector code,
   and their dependencies fixed.
3. Reset equivalent test state and start a new run. The intended item should
   fail with observed evidence and comparable coverage. A critical gate should
   produce exit 2; an execution error (exit 1) does not count as detection.
4. Compare the good and broken run directories with `aek compare --baseline
   /path/to/good-run --candidate /path/to/broken-run --fail-on-regression`.
5. Restore the good target and run `aek run --split all`. Review and finalize
   required manual work, then promote that restored run with `aek baseline
   promote --run /path/to/restored-good-run --name main --reviewer YOUR_NAME`.
   The default release promotion policy requires the `all` split, the complete
   required suite, 100% coverage, and passed gates. If you configure a different
   [promotion policy](evidence-workflows.md#baseline-promotion-policy), run its
   required split and meet its thresholds instead.

If the defect is missed, revise the exercise, evidence, or rubric, then rerun
both targets using the revised evaluator. Changing evaluation inputs invalidates
comparability; do not override compatibility checks to claim calibration passed.
Command graders must declare `methodFiles`: include the checker, its dependencies,
configuration, and expected-result files, excluding the product implementation.
These files are snapshotted and hashed as evaluator inputs; changing them makes
comparisons incompatible. AEK does not infer imports, so review that the list is
complete. One pair is a useful smoke check, not a statistical estimate of judge accuracy.

The [first-run walkthrough](first-run.md) demonstrates the full comparison using
an offline cart example. Your own calibration should exercise your real target.

Onboarding is complete when preparation/reset is reproducible, criteria have
reviewed evidence, the good run has sufficient coverage and passes gates, the
broken run exposes the intended regression, and the restored run is reviewed
and promoted. Expand scenarios and reserve evaluation-split cases after this
first calibrated requirement works.
