# Release validation

## Controlled visual starter and submodule identity (0.6.3)

`aek init --kind visual` generates a runnable WebGL/Canvas2D fixture with
working, frozen, and blank calibration variants. Deterministic capture checks,
approved-baseline non-regression, aspirational preference, and interface
readability retain separate acceptance criteria. The packaged calibration
example seals three authored images and keeps its six agent-authored reviewer
labels outside judge inputs; it makes no held-out accuracy or human approval claim.
The helper accepts every supported judge provider, preserves model/effort settings,
and rejects Cursor's unsupported effort setting before creating evidence.

Explicit target fingerprint exclusions now apply recursively inside initialized
Git submodules. Real source changes, ignored runtime inputs, and revision changes
remain part of target identity. Regression coverage includes staged and ignored
excluded artifacts, clean and dirty parents, nested submodules, symlinked roots,
trailing-space paths, parent Git directory/index overrides, uninitialized
checkouts, and invalid Git state. Controlled captures also accept an explicit
total budget up to one hour while retaining bounded per-stage timeouts.

This release updates the MCP SDK and sharp dependencies. Validation on Linux
with Node 24.18.0 passed all 734 tests, formatting, lint, type checking, and
production-package smoke. The release workflow repeats these checks and tests
the exact versioned archive before publishing the tarball and SHA-256 checksum
as a GitHub pre-release.

## Fail-fast evaluation and packaged visual examples (0.6.2)

Explicitly blank CLI thresholds, provider names, and execution limits are rejected
instead of selecting zero or inherited defaults. Failed accessibility reads remain
evidence execution errors, and failed drags no longer retry through unchecked raw
mouse events.

Git receipt probes reject execution failures and malformed output. Commit identity
and dirty state come from the same status response so a concurrent initial commit
cannot retain an unborn identity. Non-Git projects still work without a Git
executable, and marker discovery respects ceiling directories, symlink handling,
and explicit Git directory overrides.

The production archive also includes the visual example, its reference image,
and the server's configurable host and port.

Validation on Linux with Node 24.18.0 passed all 699 tests, formatting, lint,
type checking, both browser smoke suites, and all seven deterministic reference
variants. Release automation smoke-tests the exact versioned archive before
publishing it with its SHA-256 checksum.

## Current browser origin checks (0.6.1)

Browser MCP preflight now reads Chromium's current frame URL instead of relying
on Playwright's cached URL. A completion request can reach the MCP process before
queued navigation notifications after a redirect; the stale URL previously let
completion reach missing-checkpoint validation instead of blocking the off-origin
page. Browser metadata remains available while navigation replaces the document's
execution context, and the check preserves URL fragments. Inspection failures
remain execution errors instead of falling back to cached origin information.

The regression test pauses the MCP process while Chromium completes an off-origin
redirect, queues completion, and verifies the blocked outcome without capturing
off-origin evidence. A separate test verifies that failed URL inspection detaches
the browser protocol session and propagates an execution error.

The fix passed all 672 tests, formatting, lint, typecheck, both browser smoke
suites, all seven deterministic reference variants, and production-package smoke
in [CI on Node 20.19.0, 22, and 24](https://github.com/DeanStr/agent-eval-kit/actions/runs/39372704593).
The 0.6.1 archive also passes production-install smoke before publication with its
SHA-256 checksum. Existing release archives and consumer pins remain unchanged.

## Benchmark experiment CLI (0.6.0)

`aek benchmark experiment --recipe recipe.json --output new-directory` exposes
controlled acquisition through the CLI, with preparation and visit progress,
report paths, and explicit outcome exit codes. Expected SIGINT/SIGTERM
interruptions retain cleanup and 130/143 status without an error stack trace.
Unrelated errors still retain diagnostics.

Config-adjacent dotenv files are fingerprinted even outside the project root.
Fresh output parent directories are created before candidate fingerprinting,
including for non-Git projects with custom run paths. After parent death,
resource locks require explicit recovery because detached workers may survive.
The benchmark guide documents how to stop those processes before removing a lock.

Validation on Linux with Node 24.18.0 passed all 671 tests, formatting, lint,
typecheck, both browser smoke suites, and all seven deterministic reference
variants. The release workflow builds the versioned archive and smoke-tests that
exact archive before publishing it with its SHA-256 checksum as a GitHub
pre-release. Existing 0.5.0/0.5.1 archives, consumer pins, and historical
acquisitions retain their original identities.

## Controlled benchmark experiments (0.5.1)

Review confirmed cross-candidate dotenv contamination, lost interruption status,
preflight output reservation and inclusion of prior managed AEK artifacts after
run relocation. Preparation and visits now run in fresh processes; failed
preflight leaves the output available, original managed paths stay excluded, and
SIGINT/SIGTERM retain 130/143 after cleanup. Distinct per-visit fixtures check
block pairing. Package smoke exercises the installed worker and isolated dotenv
values, and accepts `--archive` to validate the exact release tarball.

Target mutation remains an intentional execution error, including lifecycle
mutation: benchmark subjects must be built and fixed before acquisition. The
original 0.5.0 lock also excluded symlink aliases in a reproduced contention case;
canonicalization makes the recorded resource identity explicit. The order helper
intentionally alternates forward/reverse blocks; its middle-position limitation
for three or more candidates is documented, with explicit rotated blocks available
to application protocols. No position-independent or statistical claim is made.

Validation passed all 650 tests, including 12 focused experiment tests, plus
build, typecheck, lint and formatting. Installed-package smoke validates the
exact 0.5.1 release archive with production dependencies, four real subprocess
visits and independent gates. One earlier CI assertion expected the outer target
guard's message; the existing collector guard correctly rejected the changed
source first. The final test checks rejection and actual mutation without
requiring which guard fires first. The named 0.5.0 preview remains the exact
archive used by the initial Melbourne A/A and threshold acquisitions; those
observations are not relabelled as 0.5.1 acquisition.

## Requested authoring/image review loop (2026-09-08)

The requested `codex exec review --uncommitted` loop used `gpt-6-astra` with high
reasoning effort for three rounds. Two actionable findings were fixed: compressed
candidates now fail preflight if their PNG evidence would exceed the reader limit,
and authoring calibration accepts arithmetic roundoff in fully covered hybrid
scores while still rejecting missing coverage. The third review reported no
actionable findings. No distinct findings were dismissed as non-actionable.

Validation passed all 515 tests with concurrency limited to four, the final
reviewer's 40 targeted tests, type checking, lint, formatting, whitespace checks,
and production-package smoke. The [review record](review-loop-authoring-images-2026-09-08.md)
contains each finding, disposition, fix rationale, and regression result.

## Uncommitted-change review (2026-09-08)

Review fixes align authoring readiness with execution's scenario-target and email
validation, preserve literal whitespace in direct-image input/output paths, and
exclude nested authoring maps from Git and non-Git target fingerprints. Regression
checks cover invalid browser/email setup, quoted paths with trailing spaces through
comparison/verification/resume, and nested untracked and staged authoring notes
while ensuring product changes still affect identity.

The full suite passed 507 tests. Targeted regression suites passed 37 tests after
the fixes, along with type checking, lint, formatting, whitespace checks, and
production-package smoke. No live model calls were used.

## Direct image comparison (2026-09-08)

`aek image compare` accepts two local image files and a criterion, generates the
collection and judging setup, and retains ordinary sealed run artifacts. It
supports non-regression and strict-preference policies, optional absolute-quality
gates, repeated votes, previews, and standard run recovery.

Validation passed: 67 relevant CLI, command-collector, visual-contract, visual
integration, and direct-image tests; type checking, lint, formatting, and
production-package smoke. Direct tests cover policies, abstention, literal
criteria, invalid inputs, retained originals, integrity verification, and recovery
that reuses votes after the original files are removed. Package smoke exercises
the installed command and docs without a source checkout or dev dependencies.
Provider responses use local fixtures and mock abstentions; no live model quality
or provider authentication was tested.

## Project evaluation authoring (2026-09-08)

The packaged `aek-author` skill now supports whole-project discovery, an interview
with saved decisions, feature updates, suite generation, and calibration. The
`author` CLI installs the skill, initializes its map, and verifies map structure,
rubric links, readiness, and recorded trial provenance. Authoring notes remain
outside workspace evidence and target fingerprints.

Validation passed: 52 distinct relevant tests across authoring, CLI, initialization,
workspace isolation, and receipts; type checking, lint, formatting, skill structure,
and production-package smoke. Package smoke includes skill installation and an
offline good/defect authoring example without development dependencies.

An independent behavioral trial used an isolated two-module project with pricing
and stock requirements. The skill surveyed the project and asked three
independent decision questions before generation; simulated
user answers supplied scope, release importance, and invalid-input policy. It
generated two areas and four checks, retained three reviewed exclusions, and
passed validation. One good run passed all four checks. Four separate deliberate
target defects each failed exactly the intended check, with 100% evidence coverage
and exit 2. Evaluator fingerprints matched, target identities differed, and the
original product files were restored byte for byte. Final map status was ready
with four calibrated requirements and no open decisions or unmapped rubrics.

This is one behavioral skill trial and deterministic contract coverage, not a
measurement of interviewing quality across users or model-judge accuracy. No live
evaluation providers or external services were used. Command-only dry-run JSON
continues to list selected scenario plans rather than command-grader invocations;
`validate` and the specs identify those rubrics.

## AgentMail review/fix loop

The requested GPT-6 Astra review command completed nine rounds on 2026-09-06;
the final round reported no actionable findings. Fixes cover declaration secrecy
and stable redaction, Node 20.19 compatibility, delayed identity verification,
HTML and plain-text email parsing, decoded-text credential guards, and terminal
browser finalization. The persona regression now exercises missing-session
blocking in an unfinished scenario.

Final validation passed all 420 tests with concurrency limited to four, type
checking, build, lint, formatting, whitespace checks and production-package smoke
on Node 20.19.0. The final reviewer independently passed 92 targeted tests. The
[review record](review-loop-agentmail-2026-09-06.md) captures every finding,
decision, regression and intermediate failure. No live AgentMail inbox was used.

## Fail-fast browser evidence

Automatic and final screenshot capture no longer swallow inspection, capture or
metadata-write failures. Browser execution errors leave a retained error marker
that the runner rejects even when the agent claims completion. Credential violations
stop the scenario and prevent session promotion. A final capture that crosses the
origin boundary blocks completion; ordinary tools still report recovered origin
violations and allow subsequent actions on the allowed page. Already blocked
sessions finalize without attempting another screenshot. Failed iframe-origin
inspection now propagates as an execution error; successfully inspected opaque
sandboxes remain excluded.

Regression tests cover automatic and final credential rejection, inspection and
metadata-write failures, unique transcript steps, prevention of session saving,
runner rejection of ignored errors, and failed versus valid iframe exclusion.

Validated locally on 2026-09-06: all 413 tests passed with `pnpm test`, along with
type checking, the final build, lint, formatting, production-package smoke and
whitespace checks. No live AgentMail or subscription calls were made.

## AgentMail authentication and email evidence

AEK now exports a provider-neutral mailbox interface and an AgentMail adapter for
existing inboxes. Configured magic-link and numeric-code login flows consume the
credential in the initiating browser, verify a declared account identity, and
retain a receipt. They support both `aek auth --email` and explicitly opted-in
browser scenarios. Command collectors can correlate notification delivery and
retain content assertions through the packaged email helper.

Local integration tests exercise browser-bound challenges, both credential types,
HTML parsing, stale and ambiguous messages, identity mismatch, credential exposure,
private-file cleanup, configuration fingerprints, and saved persona permissions.
Mailbox API failures remain execution errors even when the agent reports completion;
healthy missing-email observations and unavailable authentication remain distinct.
Artifact scans check that the fixture API key, link token and code are absent.

The production-package smoke installs without development dependencies and runs
the email example against a local mailbox API, checking both correct delivery and
a deliberately incorrect body. No live AgentMail inbox or subscription provider
was used. A real application and inbox still need a live integration check. See
[email evidence and authentication](email.md) for supported flows and limitations.

Validated locally on 2026-09-06: all 403 tests passed with `pnpm test`, including
nine new email tests. Type checking, lint, formatting, both browser smoke suites,
production-package smoke (including the build), example validation and whitespace
checks passed.

Follow-up review reproduced and corrected credential leakage in session-expiry
metadata, credential guards that skipped background tabs and ran before origin
recovery, and acceptance of emails received after the observation deadline when
an API response arrived late. Codex MCP calls now use the invocation timeout,
avoiding its 60-second default cutting off the configured email wait. Regression
tests cover these paths; provider-argument checks use a fake CLI without consuming
subscription quota.

After these review fixes, all 405 tests passed with
`node --import tsx --test --test-concurrency=4 test/*.test.ts`. Type checking,
lint, formatting, the final build, both browser smoke suites, production-package
smoke and whitespace checks passed. No live AgentMail or subscription calls were
made.

## Browser and fixture fail-fast review (0.3.0)

Styled uploads now fall back only when the file chooser wait times out after a successful click. Failed clicks, origin checks, chooser uploads, input discovery, and fallback uploads propagate instead of silently trying another input. Failed form or scroll inspection no longer fabricates an empty option list, editable metadata, or an immovable page. Failed combobox typing also remains an execution error. Configured fixture files that disappear before snapshot creation now stop the run with the missing source path.

Valid chooser absence, custom controls, and absent scroll containers retain their normal behavior. Regression tests cover execution failures separately from successful nested-input fallback and a fixture disappearing after receipt creation.

Validation: all 330 tests, type checking, the build, both browser smoke suites, and diff checks passed. No live subscription providers were invoked.

## Uncommitted-change review: threshold equality (0.3.0)

Review reproduced a floating-point regression in the full-precision threshold change: an exact 29% score or coverage was represented as `28.999999999999996%`, incorrectly failing a 29% requirement and withholding the score. CI and score withholding now share a comparison that allows only machine-level arithmetic roundoff at equality. It does not use display rounding as a tolerance.

The new regression test failed before the fix. It covers exact decimal boundaries for score, coverage, and withholding, and confirms that real deficits of 1e-8 percentage points still fail. The existing 99.9999%-versus-100% regression remains covered. The browser extraction preserves all 11 moved method bodies; review found no further actionable issues in the grader provenance or run recovery changes.

Validation: all 315 tests, type checking, the build, and diff checks passed. No live subscription providers were invoked.

## Command grader provenance and precise thresholds (0.3.0)

Command graders now require an explicit `methodFiles` list. Declare checker scripts, their evaluator dependencies and configuration, and expected-result files; use `[]` only for a fully inline check. These files are snapshotted, hidden from workspace collection, checked before and after execution, and included in the evaluator fingerprint. Changed checker logic makes comparisons incompatible. Offline rescore preserves the original checker hashes even if the current checker changes or disappears. AEK does not infer dependencies from commands or imports.

Run, rescore, and finalize thresholds and score withholding now derive from full-precision area weights. A value of 99.9999% no longer satisfies a 100% threshold despite displaying as 100%. Display percentages remain rounded.

Run state/locking, interrupted-write recovery, input snapshots, and receipt updates now have dedicated modules under `src/run/`. Browser forms, pointer/scroll interactions, and uploads use explicit session-owned interaction contexts. The extracted browser implementations retain their previous behavior; origin enforcement remains in the session. See [internal boundaries](internal-boundaries.md).

This changes the evaluator method and command grader contract. Update command specs and regenerate runs and baselines; no migration layer is provided.

Validated locally on 2026-09-05: type checking, all 314 tests, both browser smoke suites, production-package installation smoke (including the build), all seven deterministic reference cases, and diff checks passed. Regression coverage includes checker/snapshot tampering, checker self-modification, incompatible checker comparisons, offline provenance retention, and score/coverage rounding boundaries. No live subscription providers were invoked.

## Judging review/fix loop (0.2.2)

The requested `codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="medium"'` review completed on 2026-09-05 with no actionable findings in its first round. Type checking, all 286 tests, and diff checks passed. No implementation fixes or finding dismissals were needed. The separately recorded `review-loop-judging-2026-09-05.md` is not included in this checkout.

## Fail-fast judge claims and aggregation (0.2.2)

Rubric and case claims now reject unknown or out-of-scope citations and non-abstaining verdicts without citations. Defects must cite reached evidence; unsupported defects and invalid references within otherwise valid citation lists are rejected instead of discarded. Errors identify the claim and retained diagnostics. Explicit abstentions may omit citations, blocked cases still reduce coverage, and configured low-confidence voting remains an abstention.

Missing repeated-vote or pairwise scenario results now raise execution contract errors before aggregation. Prompts and documentation describe the stricter citation rules. Regression coverage exercises single/repeated rejection, prevents malformed votes from being journaled, verifies repaired output succeeds, and preserves blocked-case coverage.

Validation: all 286 tests passed, along with type checking, the build, and `git diff --check`. No live subscription providers were invoked.

## Uncommitted-change review: ordinary judge image access (0.2.2)

The review reproduced one issue: an ordinary judge rerun in a partially completed area could inherit a prior invocation's image-view transcript. A later pairwise vote can seal those files before another vote fails, so resume legitimately retains the old transcript. The fresh judge could then cite an image without viewing it.

Fresh ordinary invocations now remove the previous image-view transcript before launching the provider. Completed repeated votes bypass this launch path and retain their sealed transcripts. A regression test failed before the fix, and an integration test verifies actual area recovery: the first attempt seals an ordinary judgement and a pairwise vote, the next attempt rejects missing fresh views, and the repaired attempt completes while retaining the original collected evidence and completed pairwise vote. No other actionable findings were identified in the reviewed diff.

Validation: all 284 tests passed, type checking passed, production-package smoke (including the build) passed, and `git diff --check` passed. No live subscription providers were invoked. Changes remain uncommitted.

## Shared judging contracts and first-run guide (0.2.2)

Identity checks, stable case requests, canonical citations, rubric normalization, screenshot access, and case aggregation now have shared implementations under `src/judging/` and `src/evidence/inspection.ts`. Saved repeated votes also require the exact requested identities. Single and repeated rubric modes constrain a proposed full pass with the same all-member aggregate; any unavailable case makes that derived aggregate unavailable, all observed negative cases yield fail, and mixed observed outcomes yield partial. Independent non-pass rubric verdicts remain authoritative; pairwise results are derived directly from all required comparisons. The kit version advances because this resolves earlier single/repeated aggregation differences. Regenerate runs and baselines for this method. See [shared judging contracts](judging-contracts.md).

The [first-run guide](first-run.md) uses the copyable `examples/first-run` cart fixture without browser or subscription dependencies. An end-to-end CLI test verifies its 100% score / 80% coverage baseline, deliberately broken 25% score / 80% coverage candidate, critical gate failure, compatible comparison, retained evidence, and expected exit codes.

Validated locally on 2026-09-05: all 282 tests passed, plus type checking, the build included in production-package smoke, package smoke, all seven deterministic reference variants, and diff checks. The new guide links resolve. No live subscription providers or human calibration reviewers were invoked.

## Judge contracts and campaign completion (0.2.1)

Ordinary rubric and case screenshot citations, including defect citations, now require selected direct attachments or successful MCP image views. Ordinary and pairwise judges share transcript validation; failed or malformed views cannot establish access. Text-only evidence and explicit abstentions remain valid. Missing, unexpected, and duplicate rubric/case identities are execution-contract errors rather than substituted abstentions. Invalid repeated votes are not journaled and can be retried.

Campaign comparisons now show and gate completion rate (completed / attempted repetitions) independently of score, evidence coverage, and critical gates. Pending repetitions are excluded; execution failures do not receive invented product scores. This detects completion regressions in command-only campaigns with no case measurements.

The kit version advances to invalidate reuse under the older judge contract. Regenerate runs and baselines for the new method; no migration or publication is included.

Validated locally on 2026-09-05: all 278 tests passed, plus type checking, build, production-package smoke, and all seven deterministic reference variants. Focused follow-up tests verify equal completion rates across unequal campaign sizes and transcript validation against the real evidence MCP. CLI checks confirm missing judge results fail the run with retained diagnostics and released locks, and completion regressions write JSON/HTML before exiting 2. No live subscription providers or human calibration reviewers were invoked.

## Codex review/fix loop (0.2.0)

Validated locally on 2026-09-05 through four `codex exec review --uncommitted` rounds using `gpt-6-astra` at medium reasoning effort. Fixed three actionable findings: Chromium provenance now uses the configured launch mode, browser probing respects split and scenario selection, and skipped/dependency-blocked area evidence is sealed before visual grading. The final review reported no actionable regressions; no findings were dismissed. All 242 tests, type checking, build, and production-package smoke passed. See [the per-round findings and decisions](review-loop-2026-09-05.md).

## Fail-fast visual contracts (0.2.0)

Validated locally on 2026-09-05: all 237 tests passed, plus type checking, build, and production-package smoke. Non-abstaining MCP pairwise judgments require successful views of both images; violations abort before a completed vote is recorded. Invalid controlled screenshot labels fail before collection or reference loading, and completed controlled captures must contain required screenshots. Browser diagnostics enforce their record schema before exclusions and reject missing streams after recording starts. Unexpected vote outcomes and terminal decisions raise contract errors. Regression coverage verifies that explicit abstention, blocked scenarios, and missing ordinary-agent evidence remain unavailable coverage, including successful resume after a failed judge contract. Visual method revision 4 requires fresh runs for these stricter contracts. No Traffic migration or live judge calls were performed.

## Review of uncommitted visual changes (0.2.0)

Validated locally on 2026-09-05 after review fixes: all 230 tests passed, plus type checking, build, both browser smoke suites, and production-package smoke. Regression tests reproduced and now prevent false diagnostic passes without a browser, lossy JPEG re-encoding during source preparation, replacement of corrupted completed votes on resume, loss of partial capture measurements, and reuse of sealed scenarios after startup changes the target before the first area report. Additional checks cover a shared diagnostics limit across pages and reference snapshots matching their receipt. Visual method revision 3 invalidates earlier measurement methods. No live judge calls were used.

## Generic visual checks (0.2.0)

Validated locally on 2026-09-05: the full suite passed all 224 tests. After the final sequential-image processing and grader-order adjustment, all 20 focused visual/integration/grader tests passed again. Type checking, build, production-package smoke, and all seven deterministic reference variants passed. The installed package example now also exercises scoped image distinctness and image-health checks.

Coverage includes independent motion/repeatability tolerances, cropped temporal checks, connected dark/highlight regions, RGB distinctness, explicit group and metric contracts, missing cohort members, near-zero relative baselines, absolute bounds, aggregate cancellation of individual regressions, sealed candidate/reference tampering, image baseline promotion, and report loading. The visual method revision participates in evaluator fingerprints; earlier visual runs require fresh collection. No Traffic migration or live model judging was performed for these additions.

## Visual evaluation and repeated judging (0.2.0)

Validated locally on 2026-09-05: all 216 tests passed, along with type checking, the build, both browser smoke suites, the seven deterministic reference variants, and the production-package smoke. Package smoke now exercises controlled PNG capture and pairwise abstention using only installed production dependencies. Playwright is pinned to the validated version so fresh consumers use the same browser revision.

New regression coverage includes independent capture passes and temporal metrics, capture cancellation, missing metric contracts, occupied target endpoints, blind vote normalization, abstention versus equivalence, interrupted pairwise and rubric-vote resume without recollection, image baseline integrity, normalized panels, bounded PNG screenshots, diagnostic checks, and escaped HTML with localized findings. The example's mock judge leaves its visual gate unavailable and exits 2 even though deterministic checks pass.

No live subscription judges or human visual-calibration reviewers were invoked. Mock and fake-provider checks validate harness behavior, not visual-judge accuracy. See [visual evaluation](visual-evaluation.md) for contracts and limitations.

Evaluator fingerprints now include reference-image hashes and browser/image runtime versions. Regenerate runs and baselines when upgrading; pre-release artifact compatibility is not promised. Image-bearing baseline promotion is explicit through `--include-images`.

Run `pnpm typecheck`, `pnpm test`, both browser smoke suites, `pnpm test:reference`, and `pnpm smoke:package` before release. CI runs those commands on Linux with Node 20.19.0, 22, and 24; it does not use subscription credentials or invoke real providers. The package smoke rebuilds before packing and installs a fresh consumer with production dependencies only.

The workflow uses the official [checkout](https://github.com/actions/checkout), [Node setup](https://github.com/actions/setup-node), and [pnpm setup](https://github.com/pnpm/action-setup) actions pinned to commits. It has read-only repository permissions and does not publish packages.

## Reference outcomes

The reference suite specifies cart arithmetic independently in `scripts/fixtures/reference/expected.json`. Seven implementations cover equivalent correct totals, ignored or defaulted quantities, dropped line items, incorrect currency units, and a missing total operation. The command oracle executes the same examples against each implementation. Maintainers should review both the contract and expectations before treating them as a calibration dataset.

The LLM cart rubric explicitly evaluates source code. The judge may use an inspected implementation and a complete static counterexample to establish a source defect. Runtime and persistence criteria still need exercised evidence. An initial live reference run exposed the need for this distinction: the judge correctly identified ignored quantities but abstained because the earlier generic verdict definition required runtime execution. That exploratory result was retained; it is not counted as a successful reference check.

`pnpm test:reference` checks the fixtures and the complete deterministic grading/report pipeline without model quota. Its results are not evidence of LLM judge accuracy.

`pnpm test:reference --provider codex --judge claude --repetitions 3` runs the same fixtures through real, separate collector and judge invocations. Provider and judge can each be `codex`, `claude`, or `grok`; judge defaults to the collector provider. Every target receives a neutral directory and project name. Expected verdicts, alternative implementations, and the oracle remain outside its workspace view. No expected verdict is supplied to the agents.

`reference-results.json` retains every observation, its original run directory, exact-verdict agreement, false alarms, missed defects, abstentions, and execution errors. A partial/fail/not-found verdict on a known negative counts as detected, while exact agreement is measured separately. Valid unavailable evidence is an abstention. Infrastructure failures and missing or invalid results have a separate execution-error status and count, with diagnostics and no substituted verdict or score. Both make the check fail. A positive fixture must fully pass. Raw prompts, evidence, CLI versions, arguments, and integrity indexes remain in the associated run artifacts.

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

### File evidence and evaluation scope (0.4.0)

Browser downloads and command collectors now retain file bytes, hashes, format metadata,
and collection provenance. Command collectors support scalar/file outputs and verified
file inputs. The package exports deterministic JSON/CSV/ZIP inspection helpers.
Named evidence checkpoints let explicitly scoped criteria remain judgeable after a
later scenario blockage. Evaluator-declared applicability exclusions have separate
reporting and do not reduce coverage. These changes advance the evaluation method
version; regenerate prior runs and baselines instead of treating them as compatible.

Target preparation now records success/failure per run, including every campaign
repetition. Resume skips only sealed successful preparation and retries failures.
See [file evidence and scope](file-evidence.md) and [state preparation](evidence-workflows.md#preparing-state-for-repeated-runs)
for contracts, examples, and limits.

Validated locally on 2026-09-06 with Node 24.18.0: all 387 tests passed using
`node --import tsx --test --test-concurrency=4 test/*.test.ts`. Unbounded-concurrency
runs exposed a timing-sensitive existing off-origin redirect test; it passed in
isolation and in both bounded full-suite runs. Type checking, lint, formatting,
both browser smoke suites, and all seven deterministic reference variants passed.
The production-package smoke rebuilt and installed the tarball without development
dependencies and verified both matching and deliberately incorrect CSV exports
through the packaged file helper. No live subscription providers were invoked.

Follow-up review corrected scalar/file binding ambiguity, missing checkpoint
requirements and prototype-named checkpoint lookups, concurrent workspace transcript
steps, download clicks that could outlive a timeout, and incomplete ZIP integrity
checks. Regression tests cover failed-download cleanup, shared checkpoints across
matrix cases, ZIP descriptors and trailing compressed bytes. The browser redirect
test now checks containment across action boundaries and explicitly releases delayed
redirects instead of depending on timer scheduling.

After these corrections, the normal `pnpm test` command passed all 390 tests with
default concurrency. Type checking, lint, formatting, the build, and the installed
production-package smoke also passed. No live subscription providers were invoked.

The subsequent fail-fast review made a completed command collector's missing required
outputs an execution error; collectors must explicitly report `blocked` when outputs
are unavailable. Successful download, checkpoint, and output publications must retain
their metadata during collection, resume, and rejudging. Resume validates sealed setup
records before deciding whether to retry or skip preparation, rejecting malformed or
contradictory records without rerunning setup. Valid blocked scenarios and unpublished
optional evidence still reduce coverage normally.

After these fail-fast changes, all 391 tests passed with the normal `pnpm test`
command. Type checking, lint, formatting, and the production-package smoke (including
a fresh build) also passed. No live subscription providers were invoked.

The subsequent requested Codex review/fix loop completed three rounds using
`gpt-6-astra` with high reasoning effort. It corrected browser metadata publication
before failed postflight checks, retained-path collisions between distinct file
labels, and ZIP filename decoding that ignored the encoding flag. The final review
reported no actionable findings; all 394 tests, type checking, lint, formatting,
the production-package smoke with a fresh build, and whitespace checks passed.
The separately recorded `review-loop-2026-09-06.md` is not included in this checkout.
