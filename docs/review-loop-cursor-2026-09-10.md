# Cursor CLI review/fix loop — 2026-09-10

Scope: all uncommitted changes adding Cursor CLI collection and judging,
configuration and artifact provider IDs, doctor and version receipts, reference
smoke support, documentation, and tests. Changes remain uncommitted.

Each review uses the exact requested command, with no extra review instructions:

```sh
codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

Raw review output and targeted test output are retained locally under
`.agent-eval/reviews/cursor-2026-09-10/` (ignored by Git). The review headers confirm
`gpt-6-astra` and high reasoning effort. Duplicate rendering of a review's final
answer in its raw output is counted once, not as another finding.

## Round 1

Raw output: `round-1.log`. Review exit status: 0.

The reviewer reported two P2 findings. Type checking and all 564 tests passed
before the fixes; those tests did not cover either reported defect.

### Exempt session-only todo tools from evidence violations

Finding: `updateTodosToolCall` and `readTodosToolCall` were caught by the native-tool
policy and invalidated otherwise valid collection and judging.

Decision: **Correct and actionable.** The installed Cursor CLI defines todo
operations over session todo entries and filters; they cannot inspect target
files or import external evidence. A fresh isolated invocation also prevents
these tools from retrieving a prior session's state. Rejecting their use is a
false evidence-boundary violation during ordinary multi-step work.

Fix: allow precisely these two bookkeeping operations. Keep native file,
command, web, and unapproved MCP operations restricted. Do not broaden the
configuration's native-tool permissions or add a fallback for other tool names.

Regression coverage: replay todo start/completion events for both scenario and
judge invocations without an MCP; confirm valid results have no policy violations.
Then combine todos with native file access and an unapproved MCP call and confirm
those evidence violations are still retained.

### Preserve usage supplied by Cursor result events

Finding: the event schema stripped the terminal `usage` object, and ProviderResult
did not return available token accounting.

Decision: **Correct and actionable.** The prior live smoke's SOURCE, PROFILE, and
judge terminal events all contain usage. For example, SOURCE reported inputTokens,
outputTokens, cacheReadTokens, and cacheWriteTokens. Discarding this data violates
the shared ProviderUsage contract and the documented provenance behavior.

Fix: validate usage as an optional object and preserve it unchanged in
ProviderResult, including provider-specific nested fields. Keep it absent when
omitted; reject malformed usage rather than inventing counts or substituting an
empty object. Existing scenario and judge code already persists ProviderResult
usage, so no separate accounting or migration layer is needed.

Regression coverage: preserve a live-shaped token object with nested metadata;
reject an array in place of usage; verify that omitted usage stays absent.

## Findings judged non-actionable

None. Both distinct Round 1 findings were accepted and fixed. The repeated final
rendering in the raw review log is a duplicate presentation, not a separate issue.

## Validation after Round 1 fixes

- `node --import tsx --test test/cursor.test.ts test/providers.test.ts test/credentials.test.ts`: all 18 tests passed (`round-1-tests.log`).
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm exec biome lint --error-on-warnings src/providers/cursor.ts test/cursor.test.ts`: passed.
- Formatting of changed TypeScript files and `git diff --check`: passed.

## Round 2

Raw output: `round-2.log`. Review exit status: 0. The same command reviewed the
complete updated change set, including the Round 1 fixes, regression tests, and
this record as it stood before adding the final result.

Reviewer result:

> No actionable defects were found in the current changes. Type checking and all
> 566 tests passed, including the new Cursor adapter tests.

Decision: **No actionable findings.** No individual findings were supplied to
accept or dismiss. The latest review is clean, so the loop ends.

Reviewer verification: type checking and all 566 tests passed. The complete test
output is also saved as `round-2-full-tests.log`.

## Final outcome

Two review findings were fixed: harmless session todos no longer invalidate
Cursor evaluations, and supplied terminal usage is retained without fabricating
missing accounting. No false positives, unrealistic edge cases, style-only
suggestions, or distinct duplicate findings required dismissal.

Validation after the fixes includes 18 targeted provider/credential tests, the
full 566-test suite, type checking, build, targeted lint, formatting, and whitespace
checks. No additional live model evaluation was needed for these two changes;
regressions use local CLI fixtures and the actual live-run usage field shape.
Before this review loop, the live Cursor workspace/browser/judge smoke passed
with 100% coverage; that result is not a new live run of the post-review fixes.
