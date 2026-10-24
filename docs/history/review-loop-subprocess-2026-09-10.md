# Subprocess and packaged first-run review loop — 2026-09-10

Scope: all uncommitted changes to subprocess output buffering, backpressure and
cleanup, the packaged first-run walkthrough, deployment guidance, and tests.
The manual-review fixes were already present when this loop began.

Each review uses the requested command without additional review instructions:

```sh
codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

Raw output is retained locally under
`.agent-eval/review-subprocess-2026-09-10/`, which is ignored by Git. This document
records the findings and their disposition. Changes remain uncommitted.

## Round 1

Log: `round-1.log`. Exit status: 0. The header confirms `gpt-6-astra` with high
reasoning effort.

Reviewer result:

> No actionable regressions were found in the staged, unstaged, or untracked
> changes. All 23 process tests, TypeScript typechecking, and the package smoke
> test passed.

Decision: **No actionable findings.** No individual findings were supplied to
accept or dismiss. Duplicate rendering of the final result in the raw log is
counted once.

Reviewer verification: all 23 subprocess tests passed, type checking passed, and
production-package smoke passed, including the installed first-run walkthrough.

## Round 2

Log: `round-2.log`. Exit status: 0. The header confirms `gpt-6-astra` with high
reasoning effort. This confirmation reviewed the complete uncommitted change set,
including this review record as it stood before the result was added.

Reviewer result:

> No actionable regressions were found in the current changes. All 23 subprocess
> tests, TypeScript typechecking, and the production-package smoke test passed,
> including the installed first-run walkthrough.

Decision: **No actionable findings.** No individual findings were supplied to
accept or dismiss. The latest review completed cleanly, so the loop ends.

Reviewer verification: all 23 subprocess tests, type checking, and the complete
production-package smoke passed again. Duplicate rendering of the final result
in the raw log is counted once.

## Fixes, validation, and disposition

No additional implementation fixes were required by either round. The reviewed changes
already bound provider event lines, avoid buffering lines without a consumer,
apply per-stream log backpressure, and reject output failures. They also include
the preceding manual-review fixes for leaked log streams on synchronous spawn
failure and suppressed process-tree cleanup diagnostics. Regression tests cover
those paths. The installed package now includes the offline first-run fixture,
and deployment guidance explains the external isolation boundary and resource
limits.

Immediately before this loop, all 559 tests passed with test concurrency limited
to four, along with production-package smoke, type checking, lint, formatting,
and whitespace checks. Both review rounds independently repeated the checks listed
above. The final review record also passed whitespace checks.

No false positives, duplicate findings, unrealistic edge cases, or style-only
suggestions were reported in either round. The review command invokes the requested
live model; evaluation providers in the tests use local fixtures and mocks.
These checks do not establish live evaluation-judge accuracy.
