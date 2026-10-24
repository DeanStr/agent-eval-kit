# Grader types

Each rubric item in an [area spec](specs.md) declares a `grader`. This guide
covers the general-purpose `llm`, `command`, `manual`, and `hybrid` graders.
Specialized graders are documented with their evidence types:

| Grader | Guide |
| --- | --- |
| `text-pairwise`, `text-rubric` | [Text evaluation](text-evaluation.md) |
| `pairwise` | [Blind pairwise grading](visual-evaluation.md#blind-pairwise-grading) |
| `capture`, `image-distinctness`, `image-regression` | [Controlled capture](visual-evaluation.md#controlled-browser-capture), [distinctness](visual-evaluation.md#scoped-image-distinctness), [baseline statistics](visual-evaluation.md#image-statistic-baseline-checks) |

See [shared judging contracts](judging-contracts.md) for identity, citation,
image-access, and case-aggregation rules across grading modes.

## `llm`

`llm` asks the configured independent judge to assess the collected evidence.

```yaml
grader: { type: llm }
```

## `command`

`command` is deterministic and runs after the area's scenarios. Every command grader must declare `output: exit-code` or `output: json`; formats are never guessed. In exit-code mode, codes map to `0=pass`, `1=fail`, `2=partial`, `3=cannot_judge`, `4=not_found`, and plain output becomes the reasoning. Other exit codes, signals, and timeouts fail the run. JSON mode requires exit code 0 and an exact, schema-valid JSON object on stdout; malformed output or nonzero exits fail the run instead of falling back to exit-code grading:

```json
{
  "verdict": "pass",
  "confidence": "high",
  "reasoning": "All 143 tests passed.",
  "evidenceRefs": ["graders/TEST-01.stdout.txt"]
}
```

```yaml
grader:
  type: command
  output: exit-code          # use json for the structured object above
  command: node evals/check.mjs
  methodFiles: [evals/check.mjs, evals/expected.json]
  cwd: project                # project | run | path relative to project
  timeoutSeconds: 300
```

`methodFiles` is required. List every checker script, checker dependency, configuration file, and expected-result file that defines the grading method, excluding the product implementation being evaluated. Paths resolve from `project.root`; explicitly declared absolute paths are also supported for shared external checkers. Use `[]` only when the complete check is inline in `command` and has no external evaluator inputs. AEK does not infer dependencies from shell commands or imports.

These files are hashed into the evaluator fingerprint, snapshotted under `inputs/grader-methods/`, hidden from workspace collection, and verified before and after each command grader. Changing a declared checker makes comparisons incompatible and prevents resume; offline rescore keeps the original checker provenance. Missing files fail validation before execution.

Command graders receive `AEK_PROJECT_ROOT`, `AEK_RUN_DIR`, and `AEK_RUBRIC_ID`.

While writing a checker, run it with `aek check CORE-01`: AEK executes it as a
run would and prints the verdict or checker error, without creating a run. See
[develop a command checker](cli.md#develop-a-command-checker).

### Checker helpers

With AEK installed in the project, JSON checkers can import small helpers instead
of writing the verdict object themselves:

```js
import { expectEqual } from "agent-eval-kit/grader";
import { total } from "../cart.mjs";

expectEqual("two items at 500 cents", total([{ priceCents: 500, quantity: 2 }]), 1000);
// stdout: {"verdict":"fail","confidence":"high","reasoning":"two items at 500 cents: expected 1000; received 500.","evidenceRefs":[]}
```

| Helper | Reports |
| --- | --- |
| `expectEqual(label, actual, expected, options?)` | `pass` when deeply equal, otherwise `fail`, with "label: expected X; received Y." |
| `check(condition, reasoning, options?)` | `pass` or `fail` with your reasoning. |
| `pass`, `fail`, `partial(reasoning, options?)` | That verdict. |
| `report({ verdict, reasoning, confidence?, evidenceRefs? })` | Any verdict, including `not_found` and `cannot_judge`. |

`options` may set `confidence` (default `high`) and `evidenceRefs`. Each helper
writes one JSON line to stdout and throws if the process already reported a
verdict, so keep other output on stderr. Let unexpected errors throw: a broken
checker must exit nonzero so the run records an execution error rather than a
product verdict. Keep the expected value independent of the implementation under
test. Add the checker to `methodFiles`; the helper module is part of the installed
AEK version recorded in each receipt. Starter checkers stay dependency-free so they
also work with a globally linked `aek`.

### Reuse existing tests

Connect relevant unit, integration, or end-to-end tests
through a command grader instead of duplicating their assertions. AEK executes the
configured command; it does not discover tests or automatically turn each test into
a rubric item. Select tests that establish the item's requirement, or use a whole
suite as one aggregate regression check. A passing unit test alone cannot establish
an unexercised end-to-end workflow.

Use `output: exit-code` directly only when the command honors AEK's verdict mapping.
Some runners use exit 1 for both failed assertions and setup errors, or exit 2 for
invalid invocation; AEK would interpret these as `fail` and `partial`. It cannot
distinguish those causes from the exit code alone.

When necessary, use a small project-owned adapter with `output: json` to run the
existing tests and translate their structured results. Read only results produced
by that invocation, using a fresh output path or removing the adapter's previous
result file before launch. Validate the runner's completion status, selected tests,
and report before assigning a verdict. Missing/malformed results, invalid selection
with no matching tests, setup failures, signals, and timeouts are execution errors,
even if the runner also reported passing or failing assertions. Do not swallow a
runner error just because a result file exists.

For a valid execution, observed product assertion failures produce `fail`; a `pass`
requires the expected tests to have executed and passed. Required skipped tests
cannot establish a pass: use `cannot_judge` when valid missing evidence prevents a
verdict, and explain what was skipped and why. Skips caused by broken setup remain
execution errors. Never turn an empty failure list into a pass without verifying
execution.

The adapter must exit 0 and emit exactly one AEK verdict object for a valid result,
even when tests failed. Execution errors must exit nonzero. Send runner logs to
stderr or retain them under `AEK_RUN_DIR` and reference them in `evidenceRefs`;
do not mix them into JSON stdout. Declare the adapter, selected test files, runner
configuration, and other grading dependencies in `methodFiles`, excluding product
code. Verify the connection with passing tests, a failed assertion, and a runner
error, plus skipped/no-match cases where supported. If the adapter reads report
files, verify that an old passing report cannot mask a failed new invocation.
This reuses the test logic while preserving the distinction between product failure
and an invalid evaluation.
For runnable code, YAML configuration, and failure trials, see the
[worked Node.js test adapter](existing-tests.md).

## `manual`

`manual` contributes no score or coverage until finalized:

```yaml
grader: { type: manual }
manualInstructions: Confirm the email arrived once and all links work.
```

Complete pending manual checks with [`aek finalize`](runs.md#finalize-manual-checks).

## `hybrid`

`hybrid` splits the item's actual weight between automatic and manual evidence. This is not a provisional verdict that later gets overwritten; both components retain their configured share.

```yaml
grader:
  type: hybrid
  autoShare: 0.6
manualInstructions: Verify the payment appears in the sandbox processor.
```
