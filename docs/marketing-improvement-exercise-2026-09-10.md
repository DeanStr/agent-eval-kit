# Marketing demo improvement exercise

AEK detected three seeded defects in an isolated copy of its real marketing demo,
accepted a harmless wording variation, and provided actionable feedback for two
repair iterations. The combined defective target improved from 0% to 66.667% to
100%; the intermediate repair remained blocked by a critical gate. A second fresh
evaluation of the final target also passed. Every completed run had 100% evidence
coverage and the same evaluator fingerprint.

The original demo already passed the selected checks. This exercise repaired
deliberate regressions; it did not discover an unseeded defect or improve the
original product beyond its starting behavior. No harness runtime changes were
needed. The original `docs/marketing/index.html` remained byte-for-byte unchanged.

**Target and scope.** The target was the existing interactive page in
[docs/marketing](marketing/README.md), not a newly invented toy application. Its
documented behavior supplies the contracts for accepted scores, pending results,
pause/resume, and the interpretation of missing evidence. The scope was selected
by Codex under the user's instruction to perform a practical exercise. It does
not cover every aspect of the page, or claim that a human reviewed this inventory.

The [runnable suite and preparation instructions](../examples/improvement-exercise/README.md)
are retained in the repository. Private run bundles, target variants, expectations,
and the run journal are under
`../.agent-eval/experiments/marketing-improvement/`. That directory is ignored by
Git; the run links below work in this workspace while the retained bundles exist.

**The three checks.** Each has equal weight and is a critical gate.

| Check | Method | Required behavior |
| --- | --- | --- |
| BEST | Deterministic command grader over executed browser observations | A rejected 77-point revision leaves the accepted score at 68; the unverified revision retains accepted score 82, no candidate score, and 58% evidence coverage. |
| PENDING | Deterministic command grader over timed browser observations | Preparation and evaluation withhold results; pause/resume preserves phase; completed results appear at the proper point. |
| GUIDANCE | Live Codex judge over a screenshot and observed text | The unverified revision's next-action guidance requires obtaining evidence and rerunning before accepting the candidate. |

The collector used Playwright to operate actual controls in a fresh browser
context. A controlled browser clock exercised preparation, pause, resume,
evaluation, and completion. It retained the visible fields as a checksummed JSON
file and captured the Revision 04 inspector. The collector read the sealed HTML
snapshot, not the mutable target or the expected outcomes.

The scenario configuration used `agent: mock` because collection was an executable
command rather than a scenario-model call. No observations were mocked. Every
completed run used the authenticated Codex subscription with `gpt-6-astra`, high
effort, for the GUIDANCE judgment. The installed CLI was `codex-cli 0.153.4`.

**Expectations were recorded before evaluation.** The named variants and
`expected.json` were outside the evaluated project. The judge saw the active
target's captured evidence and fixed criterion, not the variant name or oracle.
Expectations came from agent interpretation of documented contracts and authored
scenario data; they were not independent human labels.

| Target | BEST | PENDING | GUIDANCE | Score | Exit |
| --- | --- | --- | --- | --- | --- |
| [Original](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-26-47/report.html) | Pass | Pass | Pass | 100% | 0 |
| [Equivalent wording](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-27-43/report.html) | Pass | Pass | Pass | 100% | 0 |
| [Incorrect guidance](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-28-13/report.html) | Pass | Pass | Fail | 66.667% | 2 |
| [Incorrect acceptance tracking](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-29-07/report.html) | Fail | Fail | Pass | 33.333% | 2 |
| [Premature result display](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-29-42/report.html) | Pass | Fail | Pass | 66.667% | 2 |
| [Combined defects](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-29-55/report.html) | Fail | Fail | Fail | 0% | 2 |
| [First repair](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-30-37/report.html) | Pass | Pass | Fail | 66.667% | 2 |
| [Final repair](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-31-26/report.html) | Pass | Pass | Pass | 100% | 0 |
| [Final repair repeated](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-32-00/report.html) | Pass | Pass | Pass | 100% | 0 |

All six planned variants matched the previously recorded expected verdicts.
Exit 2 represents observed critical-gate failure, not a broken evaluation.

**What the judge distinguished.** The valid variation said to keep using the
previously accepted 82-point revision, repair the receipt service, and collect
a fresh evaluation before making an acceptance decision. The judge accepted this
despite the wording differing from the original.

The bad variation left the UNVERIFIED badge, missing score, 58% coverage, and
explanation of the outage intact. Only its next-action guidance recommended
keeping the new candidate and shipping immediately, with evidence collected
later. The judge rejected the contradictory recommendation and cited the
[actual inspector screenshot](../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-28-13/DEMO/screenshots/unverified.png)
and collected text. Correct surrounding labels did not hide the wrong advice.

**How the feedback guided repair.** The combined run reported the wrong accepted
score, early exposure of final verdicts during evaluation, and the recommendation
to ship without evidence. The deterministic messages named actual fields and
values, such as `rejected.best-score: expected "68", observed "77"`. The model
explained the semantic contradiction in the action text.

The first repair changed acceptance tracking to include only BASELINE and KEEP
decisions, and restricted result revelation to completed or explicitly selected
states. This repaired both command checks. The rerun still failed GUIDANCE, so
the increase to 66.667% was not sufficient for acceptance.

The second repair rewrote the next action to continue with the accepted revision,
restore the receipt service, and decide about the candidate only after collecting
the missing evidence. It used different wording from both the original and valid
variation. The full suite passed, and a fresh repeat also passed. The
[combined-to-repaired comparison](../.agent-eval/experiments/marketing-improvement/comparison/comparison.html)
reports +100 score points, unchanged coverage, and no incompatible-method override.

Codex in the same authoring session made these repairs. It had previously seen
the mutation definitions, so this is not a blind study of an independent repair
agent. The experiment establishes that the reports supplied concrete repair
feedback and that the unchanged suite distinguished the intermediate and final
results. It does not establish a general autonomous-repair success rate.

**Friction found in actual use.**

1. **Extensionless source snapshots need an explicit rendering step.** The first
   collector opened AEK's content-addressed source path directly. Chromium
   displayed the HTML as text, so the expected controls were absent. The run
   stopped with exit 1 before model judging. The collector was corrected to copy
   those exact sealed bytes to `render.html` inside its output directory. A fresh
   baseline began after the method change; the failed attempt is retained at
   `../.agent-eval/experiments/marketing-improvement/runs/2026-09-10T05-25-48/`.
   No product failure or score was fabricated from this setup error.
2. **Command failures are in rubric items, even when the model's defect list is
   empty.** The acceptance-only variant had two failed command items and an empty
   `areas[].defects` list. An improvement agent must inspect `areas[].items`,
   critical gates, coverage, and execution status as well as model-written defects.
3. **Checks can overlap.** Incorrect acceptance tracking failed BEST and the
   accepted-score assertion within PENDING. Both observations were real, but they
   had one root cause. Weighted score is not a count of distinct bugs. A future
   revision could remove the duplicate assertion if independent scoring matters;
   this exercise kept the evaluator fixed after baseline instead.
4. **Custom collectors own their runtime dependencies.** AEK's dry-run preview
   said Chromium was not required because no built-in browser scenario was
   configured. The command collector nevertheless used Playwright. The example
   now documents its browser dependency explicitly rather than changing the
   harness to infer arbitrary script requirements.

**Authoring and verification.** The project map retained the original good run
and a relevant defect run for each requirement. `aek author status --json`
verified all three checks as calibrated. Its overall `ready` remained false
because `scope.reviewedBy` was deliberately absent. No human review identity was
invented to make a readiness flag green.

All nine completed artifact bundles passed integrity verification. The
evaluator fingerprint was
`67e6b84afd820d60f077328bad0436725034e1a6e9b9982999d5cc259f32f5fb`.
The final two runs had the same target HTML SHA-256,
`ba04111a036e223ee2a20585ed57533e3c4d1274b552600955b3dac9ff55ca10`.
The original demo remained at SHA-256
`214dc3cb5edc6c8fa06bd1d349385c435cc3821ff5151fe011503d6da7060400`.

The existing `node scripts/marketing-smoke.mjs` passed generation, malformed-input
preservation, playback, accessibility, and responsive checks on the original
demo. The exercise scripts passed formatting and lint checks. No new runtime
subsystem, dependency, hosted service, or external publication was introduced.

**What this supports next.** Keep the current harness. Make pilot review a normal
part of authoring, challenge important checks with valid variations and meaningful
defects, and ensure improvement instructions read all failed rubric items. The
fixed suite successfully guided this bounded repair loop. Broader judge accuracy,
failure-discovery quality, and product coverage still require evidence from more
representative tasks and independent reviewers.
