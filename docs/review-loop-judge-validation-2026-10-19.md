# Judge-validation review/fix loop — 2026-10-19

Scope: all uncommitted changes, including reference execution-error reporting,
judge validation, historical ProgramCue/GUIDANCE exercises, documentation and tests.

Every review uses the requested command unchanged:

```sh
codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'
```

Raw output, execution metadata, source input hashes, per-round findings and
check logs are retained in the ignored directory
`.agent-eval/reviews/judge-validation-sol61-axyy5yw6/`.

## Round 1

`review-01.log` completed with exit 0. The header confirms `gpt-6.1-sol` and high
reasoning effort. The reviewer passed all 609 tests, typecheck and all seven
deterministic reference cases.

### R1-F1 — Align review reasoning validation with the judgement contract

Reviewer priority: P2. Location: `src/judge-validation-review.ts:29`.

Finding: existing provider output validators and sealed report schemas permit
`reasoning: ""`, but the new review reader required a nonempty string. As a result,
a valid completed comparison could not be recorded in the decision journal.

Assessment: **correct and actionable**. The regression test supplies an actual
schema-valid provider response with empty reasoning. Evaluation succeeds, but the
recorder fails before the fix with a minimum-length validation error.

Fix: use the existing string contract in the reader and continue comparing the
reasoning exactly with the sealed judgement. Globally tightening provider/report
contracts would broaden this change; inserting default reasoning would fabricate
an explanation. Neither is needed to resolve the mismatch.

Regression evidence: `R1-F1-before-fix.log` records the failure. All 25 targeted
judge-contract, judge-validation and improvement-exercise tests pass after the
fix. Typecheck, build, repository lint, formatting, and whitespace checks also
pass; commands and statuses are retained in `post-fix-checks.json`.

Non-actionable duplicate: the CLI renders the same final finding twice. It is one
finding and one fix, not two separate issues. No false positives, unrealistic edge
cases, or style-only suggestions were reported in this round.

## Round 2

`review-02.log` completed with exit 0 using the requested model/settings.
All 609 tests, typecheck and seven deterministic reference cases passed again.

### R2-F1 — Reject case-colliding IDs before creating attempt directories

Reviewer priority: P2. Location: `src/judge-validation.ts:106–107` at review time.

Finding: IDs such as `case` and `CASE` are different strings but select the same
attempt directory on a case-insensitive filesystem. A later failed attempt can
overwrite an earlier `error.log`, losing diagnostics and breaking journal review.

Assessment: **correct and actionable**. Case-insensitive filesystems are common on
supported macOS systems; this is not an unrealistic edge case.

Fix: reject case-folded duplicate case/label IDs and enforce the same uniqueness
contract in the shared configuration schema. Checks run before creating output,
and the review reader uses the same schema. IDs keep their original spelling; no
filesystem-specific fallback or renamed attempt is introduced.

Regression evidence: `R2-F1-before-fix.log` records the missing rejections before
the fix. All 25 targeted tests pass after it, along with typecheck, build,
repository lint, formatting and whitespace checks (`round-2-checks.json`).

Non-actionable duplicate: the CLI renders R2-F1 twice. This is one finding and one
fix. No other false-positive, unrealistic-edge-case or style-only findings arose.

## Round 3

`review-03.log` completed with exit 0 using the same requested model and high
reasoning effort. The final reviewer verdict was:

> No actionable bugs were found in the staged, unstaged, or untracked changes.
> Typechecking, all 609 tests, and all seven deterministic reference cases passed.

Assessment: **no actionable findings**. No individual findings were supplied.
Repeated rendering of the clean verdict is one review result. The loop ends.

## Fixes, checks and non-actionable findings

Two distinct actionable issues were reproduced and fixed: the reader's reasoning
contract mismatch and case-folded identifier collisions. Neither fix adds a
fallback or fabricates a judgement, score, diagnostic or rationale.

Checks passed after both fixes: all 609 tests and seven deterministic reference
cases in the final review; typecheck; 25 focused tests after each fix; build;
repository lint; formatting; and `git diff --check`. Per-command logs and exit
statuses remain in the review artifact directory.

The duplicate rendering of each finding was non-actionable and covered by its
corresponding fix. No distinct false positives, unrealistic edge cases or
style-only findings were reported. Implementation and tests match the clean
reviewed tree; this result record was completed after the final review.

## Subsequent independent review fixes

A later review found two additional issues outside the three rounds above:

- Hybrid aggregates with pending manual review were counted as model abstentions.
  Validation now rejects hybrid and manual targets before judging. The journal
  reader checks sealed criterion definitions and applies the same restriction.
- Labels pinned evidence and case IDs but not the selected criterion. Labels now
  require matching `area` and `rubric` fields, preventing a case from silently
  carrying an old label to another check. Example preparation includes these fields.

Both regression tests failed before the fixes and pass afterward. The 27 focused
judge-validation, judge-contract and improvement-exercise tests passed, together
with typecheck and build. Coverage includes rejecting an otherwise consistent
historical hybrid result and a retargeted review snapshot. Existing historical
artifacts remain unchanged; older label snapshots require reviewed criterion
identities and a new comparison before they can be journaled by the current reader.
