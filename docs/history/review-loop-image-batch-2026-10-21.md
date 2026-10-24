# Image batch review and live pilot, 21 October 2026

The review/fix loop ran the following command unchanged in every round:

```sh
codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'
```

All six invocations exited successfully. Each round retained its stdout findings,
full stderr log, source snapshot, patch and before/after source hashes under
`.agent-eval/reviews/image-batch-sol61-0q9vtdir/`. The reviewer did not change
source files. The final reviewed snapshot became commit `e52a013`.

## Findings and decisions

All seven findings were reproduced and judged correct and actionable. No findings
were dismissed as false positives, duplicates, unrealistic cases or style-only
suggestions.

| Round | Finding | Fix and validation |
| --- | --- | --- |
| 1 | Cursor's explicit overload terminal event threw before retry classification. | Return a failed provider result with the real nonzero exit, preserving any answer. Reject malformed, contradictory and exit-zero failure events. Provider regressions passed. |
| 2 | Nonempty malformed answers could be mistaken for absent answers and replaced by retries. | Distinguish explicit CLI diagnostics from response text. Reject retries for malformed responses and parsed non-error values, including JSON null. Codex, Claude and Cursor regressions passed. |
| 3 | Reuse output inside the source batch invalidated its seal. | Reject canonical descendant destinations, including symlink aliases and the default output parent, before writing. Source integrity and recovery regressions passed. |
| 3 | An early queue error hid later completed retained results. | Populate all completed results before scheduling unfinished comparisons. Repeated failed resume preserves verdicts, counts and links without rerunning votes. |
| 4 | Cursor lost an emitted assistant answer when the terminal event was missing. | Preserve the captured response on failed exits. Missing terminal events on successful exits still fail explicitly. Valid and malformed answers both block retries. |
| 5 | A streamed structured answer could be replaced when a later error omitted it. | Track completed assistant responses independently of terminal fields; Claude also tracks StructuredOutput calls. Streamed answers block retries, while failed exits remain execution errors. |
| 5 | An initialization failure could leave an empty child reservation that resume could not recover. | Reclaim only an empty directory without run state, under the batch lock, with nonrecursive removal. Nonempty directories without state fail with actionable diagnostics and retain all artifacts. |
| 6 | No actionable regressions. | The reviewer passed type checking, the build and 95 relevant tests. Current source hashes matched the final review snapshot before commit. |

The initial review also fixed one-to-one reuse of duplicate fingerprints and
Claude overload classification before this six-round loop. Each actionable loop
finding received regression coverage, including intentional failing reproductions
before its fix. Final validation passed all 784 tests, type checking, the build,
lint, formatting, whitespace checks and production-install package smoke.

## Live image pilot

The subsequent pilot used commit `e52a013`, AEK runtime version 0.6.4 before the
release version bump, Node 24.18.0 and Codex `gpt-6.1-sol` with high reasoning
effort. It captured the packaged `examples/visual/index.html` in Chromium at
1000 × 600. The deliberate defect hid only region names and numeric totals.
The four comparisons used three votes each, unanimous agreement, a 0.55 minimum
confidence and a 180-second invocation timeout.

Expectations were recorded by an agent before judging, separately from the
manifest. They were not supplied to the judge. This is a small related development
family over a synthetic application, not independent human calibration or a
measurement of general accuracy.

| Case | Expected and observed result | Votes | Coverage |
| --- | --- | --- | --- |
| Identical readable screenshots, non-regression | Pass | 3 equivalent | 100% |
| Readable candidate versus missing labels, preference | Pass | 3 candidate wins | 100% |
| Missing-label candidate versus readable reference | Fail | 3 candidate losses | 100% |
| Persistence across reload, supplied only static screenshots | Cannot judge | 3 abstentions | 0% |

All four comparisons completed with no execution errors or pending work. Batch
exit 2 correctly retained the failed and inconclusive gates. There were twelve
live judge invocations; no temporary capacity failure was observed.

Completed resume and reuse with reordered rows and a renamed ID preserved all
four results. A temporary CLI wrapper allowed only `--version` identity probes
and rejected any attempted judging before a model could run. Both operations
exited 2 as expected, made zero judge calls, and retained all original vote bytes.
The original seal verified before and after reuse, and the reused seal verified.

The combined report rendered four comparisons, eight previews and thirteen valid
local links at 1280 × 900 and 390 × 844, with no horizontal overflow or page errors.
Full local preparation, expectations, sealed runs, recovery logs, results and
report screenshots remain under `.agent-eval/pilots/image-batch-2026-10-21/`.
Live verification covered Codex; capacity recovery and other provider protocols
remain covered by deterministic integration fixtures in this validation.
