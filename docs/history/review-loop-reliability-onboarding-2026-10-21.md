# Reliability and onboarding pilot — 21 October 2026

This exercise tested the existing judge-validation workflow, packaged first-use
experience, one existing ProgramCue unit test and its real draft/publication
browser flow in disposable copies. The pilot wrote only its copies; concurrent
work in ProgramCue's original checkout was preserved. It did not run a deployed
application or establish independent human agreement. Reviewer expectations
remain agent-authored.

## Twelve-case judge comparison

The retained experiment is
`.agent-eval/experiments/reliability-pilot-20261021`. Its
`comparison/validation-results.html` contains all decisions, evidence and
diagnostics; `review.html` presents the evidence without expectations or judge
predictions. The [recorded summary](../../examples/judge-validation/results-pilot-2026-10-21.json)
pins dataset, label and comparison hashes and every collection root.

Three families each contain a working target, equivalent valid presentation, a
targeted defect and withheld evidence. Browser collection executes a cart change
and reload through Playwright; file collection executes an invoice exporter;
direct text assesses a response against a supplied refund policy. Browser and
invoice families are development, and the text family is evaluation. The two
configurations were fixed before comparing, with no tuning on evaluation cases.

Both request Codex `gpt-6-astra` through CLI 0.163.0, at medium or high effort.
These are requested settings, not an independently resolved model snapshot.
The source checkout and judging runtime were AEK 0.6.4 on Linux, Node 24.18.0.

| Measurement | Medium | High |
| --- | --- | --- |
| Attempts | 12 | 12 |
| False passes / expected failures | 0/3 | 0/3 |
| False failures / expected passes | 0/6 | 0/6 |
| Abstentions / attempts | 5/12 | 5/12 |
| Execution errors / attempts | 0/12 | 0/12 |
| Decisive judgments / attempts | 7/12 | 7/12 |
| Unsupported decisions / insufficient-evidence cases | 0/3 | 0/3 |
| Correct abstentions / insufficient-evidence cases | 3/3 | 3/3 |
| Exact matches with agent expectations | 10/12 | 10/12 |
| Completed judging-run time | 105.975 seconds | 113.433 seconds |
| Recorded provider calls | 12 | 12 |

Abstentions on expected-pass cases are outside the false-failure numerator and
remain in its denominator. Zero false decisions therefore do not establish full
reliability: decision coverage must be read alongside them. Runtime includes
harness work, excludes collection, and comes from one sequential sweep. It
does not establish a speed ranking or repeated-run stability.

### Persistence evidence gap

Cases 01 and 03 visibly retain quantity two and subtotal 1000 cents. Both
configurations abstained because their action sequence was described by the
command collector, whose transcript establishes collector execution but does
not independently record the browser actions. Both detected the changed visible
values in the defective case. This asymmetry deserves inspection; the agent's
expected-pass labels are not independent proof that the positive evidence was
sufficient.

The original definitions, labels and judgments remain unchanged. Criteria were
not weakened to obtain a pass. A follow-up using the native browser collector
is recorded separately below; its collection method differs, so it is not a
matched comparison of models or judge configurations.

The initial live experiment predates the helper's metadata/generator source pins.
New preparation records those sources in the dataset; the original comparison
and completed summary are retained without a compatibility fallback or rewrite.

### Native browser follow-up

`.agent-eval/experiments/native-browser-pilot-20261021` exercised the same good
and defective cart source bytes using a native `browser` scenario. The rubric's
acceptance text stayed fixed. This used Codex `gpt-6-astra`, medium effort for
collection and judging, with a 20-interaction collection limit and 180-second
provider deadlines. The recorded transcript includes the quantity change,
commit/blur, before screenshot, same-URL navigation and after screenshot.

The working target passed at 100% score/coverage; the persistence defect failed
at 0% score and 100% coverage. The comparison was compatible and reported the
regression with exit 2. The managed local server stopped after each run, and
the disposable source was restored. This supports the evidence-source diagnosis
for this pair; it does not establish general correctness or equivalence between
the native and command collection methods. Both original studies remain intact.

## Packaged onboarding improvement

The previous authoring walkthrough required copying files, recording run IDs,
editing the target, restoring it, and editing trial paths by hand. The new
packaged `examples/authoring/run.mjs NEW_DIRECTORY` performs that documented
fixture workflow and retains each command's logs, expected/actual exit status,
and duration. It refuses an existing destination and restores the target after
the deliberate mutation, including failure paths.

The initial source pilot retained 11 CLI steps taking 6.720 seconds, excluding
package installation. Its working/restored runs scored 100% with 100% coverage;
the defect scored 25% with full coverage and a failed quantity gate.
`QUANTITY` became calibrated; `EMPTY` remained exercised because that defect
does not violate the empty-cart contract. This demonstrates the scripted
workflow and does not measure the authoring agent's interview quality.

The runner is reachable from the first-run and authoring guides and is exercised
from a production-only tarball installation by package smoke tests. An installed
skill remains available for subsequent project-specific authoring.

## ProgramCue real-source pilot

The user nominated ProgramCue during the exercise. Its existing working tree
contained unrelated edits, so the pilot copied only the current
`public-programme-filter-state.ts` module and its existing Vitest test into
`.agent-eval/experiments/programcue-onboarding-20261021/project`. It installed a
fresh AEK tarball in a sibling consumer and reused the existing Vitest dependency.
The [recorded summary](../../examples/judge-validation/results-pilot-2026-10-21.json)
pins the selected source hashes and original Git revision.

The requirement comes from the existing test: clear unavailable saved public
programme facets while preserving available filters and unrelated URL state.
The project-owned command adapter reuses that test and distinguishes assertion
failures from setup/import errors using the installed runner's typed results.
It rejects unexpected tests, missing results, unhandled errors and runtime changes.
No source assertions were duplicated in the checker.

| Trial | Result | Coverage | Exit |
| --- | --- | --- | --- |
| Actual copied source | Pass, 100% score | 100% | 0 |
| Copied product predicate inverted; test/checker fixed | Fail, 0% score | 100% | 2 |
| Intentional module import error | Failed execution, no product verdict | Unavailable | 1 |
| Original copied source restored | Pass, 100% score | 100% | 0 |

The good, defective and restored runs have the same evaluator fingerprint;
their comparison detected the regression. The requirement is calibrated from
verified trials. The map remains `ready: false` because the owner has not reviewed
this bounded mapping. Calibration does not stand in for a scope review.
The two selected original ProgramCue files had identical hashes after the pilot.
The full application, browser workflow, D1, production configuration, publication,
external delivery and all other requirements were outside this unit-test slice.

## ProgramCue browser calibration

The follow-up is retained in
`.agent-eval/experiments/programcue-browser-pilot-20261021`. Its `review.html`
places the three anonymous draft-visibility screenshots together and links the
full reports and comparisons. The
[recorded summary](../../examples/judge-validation/results-pilot-2026-10-21.json)
pins all three artifact roots, the source snapshot, mutation, comparison outputs
and final source audit.

The pilot froze 1,780 current source files and private copies of the installed
dependencies. Each run rebuilt the application, provisioned fresh local Worker/D1
state, reset the isolated fixture and captured fresh persona sessions. It used
the existing `PC-PUBLICATION` browser scenario and both publication criteria
without changing their instructions, text or weights. Collection and judging
requested Codex `gpt-6-astra`, medium effort; the existing collection budget was
120 tool calls with a 1,200-second deadline, and the judge deadline was 900 seconds.

| Trial | Draft privacy | Approval/publication | Score | Coverage | Screenshots |
| --- | --- | --- | --- | --- | --- |
| Frozen current source | Pass | Pass | 100% | 100% | 15 |
| Seeded public-title query defect | Fail | Pass | 33.333% | 100% | 17 |
| Original copied source restored | Pass | Pass | 100% | 100% | 15 |

The single product mutation changed the anonymous programme query from
`content.title` in the published snapshot to mutable `s.title AS title`. The
browser saved and reloaded a title ending in `PC-DRAFT-ONLY`; anonymous browsing
then exposed that draft title while still reporting published programme version 1.
The judge failed `PC-DRAFT-PRIVATE`, whose weight is two of the three available
points. It separately passed `PC-PUBLISH-CONTENT`: unapproved publication was
blocked, approval was explicitly saved, publication was confirmed and version 2
was observed anonymously. The restored run repeated the complete flow and passed.

All three evaluator fingerprints match. Both comparisons were compatible:
`--fail-on-regression` returned exit 2 for the defect and exit 0 for restoration.
These rubric items have no critical gates, and the coordinator supplied no score
thresholds, so all three completed evaluation commands returned exit 0. The
comparison enforced the regression. The pilot driver initially paused because
its assertion expected an unrounded score and a nonzero evaluation exit; that
assertion was corrected before continuing restoration. No evaluation definition
or retained judgment was rewritten.

All three artifact indexes verified. The disposable mutation was restored, owned
Worker state directories were removed and ports 5188/15188 were closed. At the
recorded final audit, all 1,261 original application files and the publication
spec matched the starting snapshot. Seven non-application files changed
concurrently and four UX workflow files appeared in the original checkout;
those ongoing changes were preserved and excluded from this frozen pilot.

This calibrates two existing requirements in one real local workflow. Fixture
authentication is not ordinary signup or production authorization evidence;
local publication is not deployed or external-provider acceptance. No release
baseline was promoted, the remaining ProgramCue criteria were not exercised,
and independent human label review remains pending.

## Decisions and remaining work

- Keep the existing score/coverage/error distinction and separate judge-validation
  labels. The executed controls demonstrated all three outcome classes.
- Prefer native browser action evidence for temporal and persistence claims.
  Use command collectors for project-owned extraction with explicit provenance.
- Independent review can begin with the twelve-card `review.html`; the reviewer
  can reply with case IDs and verdicts. The optional label template deliberately
  remains invalid until a real reviewer and supported decisions are supplied.
- The ProgramCue adapter remains a project-specific pilot. A reusable Vitest
  adapter is justified only if another actual consumer needs the same contract.
- Review found that edited judge configs could silently diverge from the pilot's
  advertised settings. New preparations pin case identities, labels, the
  configuration manifest and both judge configs. Comparison rejects changes
  before judge invocation; summaries check the completed comparison's snapshots
  against those pins and remain independent of later live-config edits. The
  original live reports remain unchanged; use a fresh preparation with the
  revised helper.
- Broader concurrency and team review infrastructure remain deferred. The
  observed problems were evidence sufficiency and first-use command handling.

## Validation

- Type checking, repository formatting and lint checks passed.
- All 24 focused authoring, first-run, judge-validation, report and pilot tests
  passed. The two pilot tests were rerun after adding the metadata-tampering check.
- The subsequent uncommitted-change review passed the complete 741-test suite,
  including rejection of prepared config, label, manifest and case-split changes,
  plus summaries using frozen comparison inputs after live configs change.
- Production-only package smoke passed with the installed representative pilot
  and one-command authoring runner, alongside the existing package checks.
- The live 24-attempt comparison completed with zero execution errors. Both
  native browser runs completed, their artifact indexes verified, and the
  managed local server was confirmed stopped.
- The real ProgramCue test demonstrated pass, deliberate assertion failure,
  import execution error and restoration. The original selected source hashes
  were unchanged. Local guide links and recorded outcome summaries were checked.
- Three real local ProgramCue browser runs demonstrated pass, targeted draft
  leakage and restoration at full coverage. Their unchanged criteria, matching
  fingerprints, artifact verification, comparisons and runtime cleanup were
  checked. The original checkout's concurrent work was preserved.

Independent human label review remains pending.

## Requested Codex review/fix loop

Each round runs the requested command unchanged:

```sh
codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'
```

Raw review logs, final findings, command metadata, source snapshots and per-finding
triage are retained under
`.agent-eval/reviews/onboarding-sol61-swrzc3pb/`. Each review records its input
hashes and checks that the source did not change while the reviewer ran.

### Round 1

The review completed with exit 0 using `gpt-6.1-sol`, high effort, and reported
one P2 finding: **pin the rubric specs alongside the judge configurations**.
This is correct and actionable. Changing `passCriteria` after preparation was
accepted by both comparison and summary, despite the fixed labels and review
packet. `R1-F1-before-fix.log` records the regression test accepting exit 0 where
rejection was required.

The fix pins all three prepared spec files, rejects edits before comparison and
checks sealed judged-spec receipts during summarization. A summary therefore
rejects changed criteria even when a comparison was created through the general
CLI and the live spec was subsequently restored. Completed summaries still use
their frozen inputs when only live files change afterward. No fallback or
relabeling was added. All eleven focused judge-validation/report/pilot tests,
type checking, formatting, lint and whitespace checks passed after the fix;
the production-only installed-package smoke also passed. Command output is
retained in the round's check logs.

No distinct non-actionable findings were reported. The CLI renders the same
finding in its stream log and final output; this is one issue and one fix.

### Round 2

The same requested command completed with exit 0 using `gpt-6.1-sol`, high effort.
Its final verdict was: "No actionable defects were found in the staged,
unstaged, or untracked changes." No individual findings were supplied, and the
source hashes were unchanged during the review.

The reviewer passed the build, both pilot integration tests, the complete
741-test suite, lint, type checking, production-only package smoke and whitespace
checks. The full test output is retained as `round-2-full-tests.log`; the other
command outputs are in `review-02.log`. The earlier post-fix formatting check
also passed. `triage.json` records every finding, assessment, fix and check.

The loop ends with one distinct actionable issue fixed and no remaining
actionable findings. No false positives, unrealistic edge cases or style-only
suggestions were reported. Duplicate rendering of the Round 1 finding was
non-actionable because it describes the same fixed issue. Only this completion
record was updated after the clean review; implementation and tests match the
reviewed snapshot.
