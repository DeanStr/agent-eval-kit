# Release validation

Run `pnpm typecheck`, `pnpm test`, both browser smoke suites, `pnpm test:reference`, and `pnpm smoke:package` before release. CI runs those commands on Linux with Node 20.12.0, 22, and 24; it does not use subscription credentials or invoke real providers. The package smoke rebuilds before packing and installs a fresh consumer with production dependencies only.

The workflow uses the official [checkout](https://github.com/actions/checkout), [Node setup](https://github.com/actions/setup-node), and [pnpm setup](https://github.com/pnpm/action-setup) actions pinned to commits. It has read-only repository permissions and does not publish packages.

## Reference outcomes

The reference suite specifies cart arithmetic independently in `scripts/fixtures/reference/expected.json`. Seven implementations cover equivalent correct totals, ignored or defaulted quantities, dropped line items, incorrect currency units, and a missing total operation. The command oracle executes the same examples against each implementation. Maintainers should review both the contract and expectations before treating them as a calibration dataset.

The LLM cart rubric explicitly evaluates source code. The judge may use an inspected implementation and a complete static counterexample to establish a source defect. Runtime and persistence criteria still need exercised evidence. An initial live reference run exposed the need for this distinction: the judge correctly identified ignored quantities but abstained because the earlier generic verdict definition required runtime execution. That exploratory result was retained; it is not counted as a successful reference check.

`pnpm test:reference` checks the fixtures and the complete deterministic grading/report pipeline without model quota. Its results are not evidence of LLM judge accuracy.

`pnpm test:reference --provider codex --judge claude --repetitions 3` runs the same fixtures through real, separate collector and judge invocations. Provider and judge can each be `codex`, `claude`, or `grok`; judge defaults to the collector provider. Every target receives a neutral directory and project name. Expected verdicts, alternative implementations, and the oracle remain outside its workspace view. No expected verdict is supplied to the agents.

`reference-results.json` retains every observation, its original run directory, exact-verdict agreement, false alarms, missed defects, and abstentions. A partial/fail/not-found verdict on a known negative counts as detected, while exact agreement is measured separately. Unavailable evidence and infrastructure failures are reported as abstentions and make the check fail. A positive fixture must fully pass. Raw prompts, evidence, CLI versions, arguments, and integrity indexes remain in the associated run artifacts.

These small synthetic fixtures establish whether obvious regressions are detected. They do not establish real-world accuracy, judge independence, generalization across applications, or reliable statistical uncertainty. Before a stable release, expand to representative applications, obtain human-reviewed expected results, and repeat across provider/model pairs and held-out cases. Keep unavailable results in the published denominators.

## Provider smoke

Run `pnpm smoke:provider --provider <provider>` on a machine already signed into that provider. This invokes one workspace collector, one browser collector, and one independent judge on working fixtures. The browser must save a name, reload, and retain screenshot evidence. Both rubric items must pass; schema-valid output alone is insufficient. This is opt-in because it consumes subscription quota. Each invocation has a 180-second timeout and a 20-turn budget (MCP interactions for Codex collection).

Use `--output <new-directory>` to choose artifact storage; an existing directory is refused. The default is `.agent-eval/reference/<timestamp>`. Test artifacts are private by default and may contain account or environment metadata; only deliberate public exports should be shared.

The verification record below describes individual observed checks, not a compatibility promise for future CLI versions. Rerun after provider or adapter updates. Linux is the automated release target; macOS has not been certified by this CI matrix. Native Windows evaluation is unsupported: CLI evaluation, subprocess, lifecycle, and browser entry points reject it before launch. Windows users must use Linux Node.js, provider CLIs, and browser dependencies inside WSL, without Windows executable interop. There is no best-effort Windows process-tree cleanup path.

### Observed on 2026-09-04

Linux, Node 24.18.0; development smoke runs made before the final 0.1.1 version bump:

| CLI | Workspace collector | Browser collector and judge | Result |
| --- | --- | --- | --- |
| Codex 0.153.3 | Passed | Passed; five browser screenshots retained | 100% score and coverage on both working reference criteria |
| Claude Code 2.1.251 | Completed with MCP evidence | Subsequent calls rejected an expired OAuth session | Incomplete; refresh handling was corrected and regression-tested, but a new login is needed for live verification |
| Grok 1.0.13 (5e9a58528b76) | Provider returned HTTP 402 | Provider returned HTTP 402 | Blocked by exhausted Grok Build usage balance |

Successful binary/auth-status probes do not establish available quota or a refreshable session. The failed smoke runs remain explicit abstentions, rather than passing adapter checks. Claude and Grok now preserve provider-written credential refreshes from their isolated configuration directories when the source credential file has not changed meanwhile. This prevents a rotated token from being discarded between scenarios; it cannot recover an already expired or invalidated session.

Local automated validation also passed all 188 tests on Node 24.18.0 and the 30 cancellation/process/scoring checks on Node 20.12.0, plus both browser smoke suites, deterministic reference checks, type checking, and production-package installation. The configured GitHub-hosted CI matrix has not yet run as part of this local change.

After clarifying the source-level evidence rule, Codex 0.153.3 completed the full three-variant reference suite under kit 0.1.1: `pass`, `fail`, and `not_found` all matched their expected outcomes, with no false alarms, missed defects, or abstentions. This was one repetition per synthetic case, not a general accuracy estimate. The retained local summary is `.agent-eval/reference/2026-09-04T23-33-55/reference-results.json`; the earlier exploratory abstention remains under `.agent-eval/reference/2026-09-04T23-29-40/`.

## Pre-release policy and method version

Backward compatibility is not a requirement during early pre-release development. Configuration, artifact formats, and APIs may change without legacy fallbacks or migrations; regenerate affected runs and baselines instead. Fingerprint and integrity checks remain necessary to prevent stale evidence reuse and misleading comparisons, not to provide backward compatibility.

Version 0.1.1 changes hybrid aggregate semantics, campaign failure behavior, and the judge's explicit distinction between source-level and runtime criteria. The kit version was advanced so earlier evaluator receipts cannot silently compare as the same method. No package publication is part of the local validation workflow.

The repository's license selection is still pending. The package manifest no longer lists a nonexistent LICENSE file; add the chosen license and package metadata before a public release.

### Fail-fast changes (0.1.2)

Command graders now require `output: json` or `output: exit-code`. JSON mode accepts only an exact valid object and exit 0; exit-code mode accepts only the documented codes 0–4. Timeouts, signals, unknown codes, and malformed JSON contracts fail the run with logs retained. Starter templates, examples, and the deterministic reference oracle declare their modes explicitly.

Scenario execution failures and judge execution/structured-output failures now abort rather than completing a run with uncertainty substituted for the error. Valid abstentions, blocked product scenarios, pending manual work, and discarded unsupported verdicts still reduce coverage. Campaigns and reference suites retain failed attempts in their summaries.

Browser fills no longer guess that an arbitrary button is a click-to-edit field. Agents must click it explicitly and fill the revealed input using a fresh ref. Element-detection failures/timeouts return tool errors, allowing explicit retries instead of presenting an empty interactive list as successful observation. Manual finalization rejects missing or invalid automatic hybrid components before recording revisions; a zero automatic share remains valid without an automatic result.

The method version is advanced to distinguish these semantics from earlier locally generated receipts. This is not a backward-compatibility guarantee or a package publication.

Validated locally on 2026-09-05: all 191 tests passed, along with type checking, both browser smoke suites, the deterministic three-case reference suite, repository example validation, and the production-package smoke (including a fresh build). CLI regressions confirm execution faults exit 1 without numeric thresholds, retain diagnostics, mark run state failed, and release the lock; a valid judge abstention still completes normally. No live subscription providers were invoked for these fail-fast changes.

### Comparison and recovery corrections (0.1.3)

Run-lock acquisition now has an exclusive `.run.lock-acquisition` guard covering stale-owner inspection and replacement. Competing acquisitions fail without deleting each other's locks. The guard normally exists only during the synchronous acquisition step. If a process dies during that step, retry after it exits; if the empty guard directory remains, confirm no process is acquiring the run before removing it with `rmdir <run-dir>/.run.lock-acquisition`. AEK never automatically reclaims the acquisition guard.

Scored rubric items now retain their weighted earned/judgeable/total measurements at full precision; only percentages are rounded. Item, area, tag, and stratum slices must have percentages derived from those recorded weights, including zero-denominator behavior. Comparisons use full-precision ratios to detect hybrid score changes and partial coverage loss even when aggregate verdicts or displayed percentages stay the same. Campaign case means and their differences also retain full precision until display. Both JSON and HTML show per-item score and coverage. Every saved rubric item requires scored measurements. Older report formats are rejected; there is no verdict-only fallback or migration path. The kit version advances to distinguish this evaluation method. Semantic verdict regressions still fail when partial-credit settings make their numeric scores equal. Matched items from incompatible runs are marked unavailable unless comparison is explicitly enabled.

Campaign comparisons retain all attempted repetitions in per-case coverage denominators, including abstentions, omitted case results, and failed attempts. Pending repetitions are excluded. For compatible definitions, a case absent from all attempted runs has zero coverage and an unavailable score; definition changes retain added/removed labels. Unequal campaign sizes are compared by coverage rate, not raw counts. Observed-score means still exclude unavailable outcomes. Coverage losses take precedence in case change labels; numeric score deltas remain visible. Campaign regression checks also enforce decreases in mean evidence coverage. Headline comparison metrics are calculated from eligible run records at full precision so display rounding cannot hide score or coverage decreases. Saved reports preserve structured provider usage metadata, including nested token details and service-tier labels. Saved reports and campaigns receive nested runtime schema validation; duplicate rubric/case observations and impossible score weights are rejected. Scored report cases and campaign cases require pass=1, fail/not_found=0, and cannot_judge=null; partial credit remains configurable in [0,1]. Campaign creation and loading share one run-record validator, and saved compatibility, coverage, distributions, and stability summaries must match their underlying run records.

The deterministic cart suite now has seven implementations and seven independently enumerated examples, including a second correct implementation, zero quantities, free items, repeated lines, multiple lines, and cent/dollar confusion. These additions broaden synthetic regression coverage; they are not human-reviewed calibration or evidence of real-provider accuracy.

For the next calibration dataset, select representative browser persistence, command-line error-handling, and repository source-analysis tasks. For each task, retain a working implementation and a seeded defective implementation; have two maintainers independently record the expected verdict and supporting evidence before running judges, and resolve disagreements in the expectation record. Keep evaluation cases separate from prompt-tuning cases. Run at least three repetitions of each collector/judge pairing and retain failures and abstentions in the denominators. Report results by task family and pairing, including false alarms, missed defects, abstentions, and exact agreement. Live execution and human review remain necessary before claiming this broader calibration is complete.

Validated locally on 2026-09-05: all 205 tests passed, including deterministic concurrent-lock recovery, weighted and semantic verdict comparison, campaign coverage, and nested artifact-validation regressions. Type checking, the build, both browser smoke suites, all seven deterministic reference variants, and the production-package smoke passed. The final uncommitted-change review also verified incompatible-item handling and rejection of campaign summaries that disagree with their run records; type checking, the build, all 205 tests, and the production-package smoke passed after these corrections. No live subscription providers or human calibration reviewers were invoked.
