# Execution previews and campaign recovery review loop — 2026-09-08

Scope: all uncommitted tracked and untracked changes, including execution previews,
campaign recovery, command help, the configuration reference, and prior review fixes.

Each review uses the requested command:

```sh
codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

Raw review and validation logs are retained locally under
`.agent-eval/preview-campaign-review-loop-s5z43N/` (excluded from distribution).
This document records each finding, its assessment, fixes, and verification.

## Round 1

Review log: `review-01.log`. Exit 0; the header confirms `gpt-6-astra` and high
reasoning effort. The reviewer passed type checking and 32 targeted tests.

Finding:

> [P1] Handle mutable artifacts before checkpointing failed attempts — src/campaign-run.ts:246–249.
> A later checker can change the target and fail after an earlier area was sealed.
> The refreshed receipt no longer matches the old index, so the campaign stores a
> permanent recovery error and abandons the remaining repetitions. Managed-server
> log output can produce the same problem. Preserve immutable evidence verification.

Decision: **Correct and actionable.** The reviewer reproduced the receipt mismatch
with two areas and an exit-5 checker. The finding appears twice in the raw output;
the second occurrence is a duplicate, not another issue.

Fix: verify failed-run artifacts before writing their final index. A changed receipt
must equal the receipt rebuilt from current campaign inputs and match the saved run
state. Only the two managed-server output logs may append, with the original indexed
prefix verified using bounded reads. Every other indexed artifact remains immutable.
New partial diagnostics are retained as failed-attempt artifacts, never scores.
This verification also applies when recovering an active failed attempt.

Regression: a managed target writes shutdown output after an earlier area completes;
the next checker changes the target and exits 5. The campaign must retain that failure,
finish the remaining repetitions, pass artifact verification, and reopen without
repeating work. Additional assertions reject edited log prefixes, changed completed
checker output, and altered receipts while permitting appended log output.

Validation: all 53 targeted campaign, recovery, cancellation, CLI, preview, and
integrity tests passed (`round-01-tests.log`), along with type checking, lint,
formatting, and `git diff --check`.

Non-actionable findings: the duplicate occurrence above. No distinct false positives
or style-only findings were reported.

## Round 2

Review log: `review-02.log`. Exit 0 with the requested model/effort. The reviewer
passed type checking and 33 targeted tests.

Finding:

> [P2] Handle interrupted report rewrites during campaign recovery — src/run/failed-artifacts.ts:31–35.
> Killing a two-area run after the second report replacement but before the index
> update leaves intact evaluation evidence and a changed report. Recovery stores a
> permanent error and abandons the unstarted repetition. Keep uncommitted derived
> reports separate from immutable evidence.

Decision: **Correct and actionable.** This is a distinct publication window not
covered by the first fix. Its two identical occurrences in the output are one finding.

Fix: failed-attempt checkpoints now live in the campaign directory and include all
retained diagnostics plus the original run index. Only the four derived report
outputs may differ without being accepted as results. The run's execution index
is never rewritten by campaign recovery, preserving ordinary recovery's distinction
between sealed results and partial report output. Changed immutable evidence,
rewritten server-log prefixes, and invalid receipts still fail. A malformed external
checkpoint fails explicitly rather than falling back to the run's index.

Regression: kill the process immediately after replacing its second report, resume
the campaign, and assert one retained failure plus the remaining completed attempt.
The original report bytes and execution index must remain unchanged. Verify the
campaign checkpoint and reject altered checkpoint data or report bytes on reopen.

Validation: the exact process-kill regression passes (`round-02-crash-test.log`),
as do type checking, lint, formatting, and `git diff --check`. All seven other
campaign recovery tests passed in `round-02-regressions.log`; the new test's fixture
initially repeated a globally unique rubric ID, which was corrected before its
successful rerun.

Final validation: all **527/527** tests passed in `round-02-full-tests.log`.
Production-package smoke also passed in `round-02-package.log`, including tarball
installation and installed CLI/MCP execution. Type checking, lint, formatting,
build, and `git diff --check` passed.

Non-actionable findings: the duplicated occurrence. No other findings were reported.

## Round 3

Review log: `review-03.log`. Exit 0; the header confirms the requested model and
high reasoning effort.

Reviewer result:

> No actionable regressions were identified in the current changes. Type checking
> and all 26 targeted CLI, execution-preview, and campaign-recovery tests passed.

Decision: **No actionable findings.** The loop is complete. The final full-suite
and package results above also passed against this implementation.

## Outcome

Three review rounds found and resolved two distinct issues: failed-attempt
checkpoints mishandling refreshed receipts/server output, and interrupted derived
report publication preventing recovery. Final checkpoints preserve immutable
evidence and keep incomplete reports separate from trusted execution results.

Non-actionable items were only duplicate copies of the same findings in the CLI
output. No distinct false positives, unrealistic edge cases, or style suggestions
were reported. Changes remain uncommitted.
