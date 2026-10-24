# Authoring and image comparison review loop — 2026-09-08

Scope: all uncommitted tracked and untracked changes in `agent-eval-kit`, including
project authoring, direct image comparison, documentation, examples, and tests.
Earlier manual-review fixes are part of this starting state.

Each review uses the requested command without additional review instructions:

```sh
codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

Raw review and test logs are retained locally under
`.agent-eval/authoring-image-review-loop/` and are not distributed. This document
records findings, decisions, fixes, and validation. Changes remain uncommitted.

## Round 1

Review log: `review-01.log`. The command exited 0. Its header confirms
`gpt-6-astra` and high reasoning effort. The reviewer passed type checking and
38 targeted authoring, image comparison, receipt, and workspace tests.

Finding:

> [P2] Validate the decoded candidate against the evidence-size limit — src/visual/direct.ts:95–96.
> A candidate can satisfy the advertised input limits but expand beyond 25 MiB
> when converted to PNG. A 3500×3000 JPEG of approximately 21 MB passes preflight,
> but collection creates a PNG that the evidence reader rejects, leaving an
> unresumable failed comparison. Support expanded evidence downstream or reject
> it during preflight.

Decision: **Correct and actionable.** The direct command accepts compressed
sources up to 25 MiB but retains the candidate as full-size lossless PNG. That
retained image must satisfy the evidence reader's byte limit too. Repeated copies
of this same finding in the CLI output are one finding, not separate issues.

Fix: check the decoded candidate buffer against the shared image-byte limit before
creating output. Report an actionable resize instruction. Keep the original
image and evidence-reader limits; neither silently downsample the user's image
nor increase memory/attachment limits across all consumers. References keep their
original encoding and produce bounded comparison panels, so this additional
candidate-evidence check does not reject otherwise valid reference files.
The user guide now states the decoded-evidence limit.

Regression: generate a deterministic high-entropy JPEG below the encoded limit
whose lossless PNG exceeds the evidence limit. The new test failed against the
old preflight (`round-01-regression-before.log`). It verifies rejection for both
preview and execution before output or provider calls, and acceptance of the
same compressed file as a reference.

Validation: all 42 direct-image, command-collector, and visual tests passed
(`round-01-tests.log`), along with type checking, lint, formatting, and
`git diff --check`.

Non-actionable findings: none.

## Round 2

Review log: `review-02.log`. The command exited 0 and again confirmed the requested
model and high reasoning effort. The reviewer passed type checking and 39 targeted
authoring, image comparison, receipt, and workspace tests.

Finding:

> [P2] Allow arithmetic roundoff when checking full observation — src/authoring/status.ts:101.
> A fully judged hybrid rubric with weight 0.3 and autoShare 0.1 has judgeable
> weight 0.30000000000000004 and total weight 0.3. Strict equality incorrectly
> leaves the requirement configured despite complete calibration trials. Use the
> existing roundoff-aware score comparison without admitting missing coverage.

Decision: **Correct and actionable.** Hybrid automatic/manual weight arithmetic
can introduce ordinary floating-point noise. The score is accepted by the report
contract and has full coverage; exact equality is stricter than the established
scoring and CI threshold rules.

Fix: compute coverage from the retained score weights and use the shared
`belowPercentageThreshold` comparison at 100%. Its allowance covers floating-point
arithmetic noise only. Do not compare rounded display percentages, round weights,
or introduce an independent tolerance. Keep the decisive-verdict, mock-judging,
method-compatibility, and target-identity guards.

Regression: use deterministic provider fixtures to complete passing and failing
hybrid runs, finalize the manual shares, and verify exercised/calibrated stages.
One rubric reproduces the 0.3/0.1 roundoff. Another has a real missing manual share
whose displayed coverage rounds to 100%; it remains unexercised until finalized.
The test reproduced the status bug before the fix (`round-02-regression-before.log`).
Two initial test-fixture contract errors were corrected before this reproduction;
those logs are retained as `round-02-fixture-setup.log` and `round-02-fixture-cases.log`.

Validation: all 33 authoring, scoring, and CI tests passed (`round-02-tests.log`),
along with type checking, lint, formatting, and `git diff --check`.

Non-actionable findings: none.

## Round 3

Review log: `review-03.log`. The command exited 0 and confirmed `gpt-6-astra` with
high reasoning effort.

Reviewer result:

> No actionable bugs were identified in the staged, unstaged, or untracked
> changes. Type checking and all 40 targeted authoring, image-comparison,
> receipt, and workspace tests passed.

Decision: **No actionable findings.** No individual findings were supplied to
accept or reject. The latest review is clean, so the review/fix loop ends after
three rounds.

## Verification and disposition

Both actionable findings were fixed and each regression reproduced the issue
before the fix. No false positives, unrealistic edge cases, or style-only
suggestions were reported. The repeated rendering of findings in raw Codex output
was deduplicated; no distinct finding was dismissed as a duplicate.

- Round 1 fixes: 42 relevant tests, type checking, lint, formatting, whitespace checks.
- Round 2 fixes: 33 relevant tests, type checking, lint, formatting, whitespace checks.
- Final reviewer: 40 targeted tests and type checking.
- Installed production-package smoke passed after both fixes, including authoring,
  image comparison, verification, recovery workflows, and packaged documentation
  without source files or dev dependencies (`final-package-smoke.log`).
- Full suite: all 515 tests passed, zero failures, with test concurrency limited
  to four (`full-tests.log`).

Review calls used the requested model. Evaluation tests used deterministic provider
fixtures and mock judgments; no live evaluation-provider quality was measured.
All source changes and this review record remain uncommitted.
