# Give your agent something to climb — AEK product films

## Current film

The main and quick films follow **one dispatch product**: its baseline, an AEK
finding, coding-agent revisions under the same frozen suite, and the improved
task. Scores progress from 70% to 90% to 100%, with a fresh final repeat. The
**after** is the evaluated final revision: inspect a late shipment, compare
drivers, and save an assignment to Leo with an estimated arrival of 14:18.

The walkthrough also shows a separate dashboard example. Its two policy examples
are explicitly labeled **illustrative**: the coding agent rejects a candidate
when AEK reports a critical task regression, and insufficient evidence reduces
coverage and can withhold the overall score. These are explanations of the
selection policy, not additional observed dispatch outcomes. Execution errors
remain errors.

Both fixtures use synthetic data. Actual demonstration footage is an edited
sequence of browser captures and AEK results, with camera moves and highlights
placed from measured element positions. Scores apply to each project's stated
criteria, not general product quality.

Three silent Remotion cuts, separately composed for 1920×1080 and 1080×1350,
30 fps, H.264/yuv420p:

| Cut | Duration | Story |
| --- | --- | --- |
| Product film | 60 seconds | Dispatch baseline → five fixed criteria → phone finding → agent fix (90%) → craft revision (100%) → improved task → CTA. |
| Quick cut | 20 seconds | Dispatch baseline, phone finding, two measured revisions, saved reassignment, CTA. |
| Walkthrough | 150 seconds | Dispatch loop, regression and coverage policy illustrations, a separate dashboard example, and authoring. |

On-screen dispatch facts (shipment, times, drivers, eligibility) are read from the
captured interface, and scores and findings from sealed reports. Tests bind the
copy to those reports and keep dashboard scenes and illustrative policies out of
the main and social cuts.

## Dashboard improvement session

The unchanged `examples/visual/index.html` was copied into an isolated session.
No defects were introduced. The criteria were agent-authored for this demonstration
and frozen before the first evaluation; they are not independently human-labeled
standards:

- Data values and bar proportions across weekly/monthly datasets, advance and reset;
  checked in a browser on desktop and phone, with data accuracy a critical gate.
- A clear weekly overview showing the total and leading region; assessed by a
  fresh Codex `gpt-6-astra` judgment from the captured desktop evidence.
- Phone labels, values and bars fit at 375px without horizontal scrolling;
  checked by browser geometry and font measurements.

| Evaluated revision | Data | Overview | Phone fit | Score / coverage |
| --- | --- | --- | --- | --- |
| Existing dashboard | Fail | Partial | Pass | 50% / 100% |
| Equal-width tracks and proportional bars | Pass | Partial | Pass | 83.333% / 100% |
| Computed summary and responsive hierarchy | Pass | Pass | Pass | 100% / 100% |
| Fresh evaluation of unchanged final revision | Pass | Pass | Pass | 100% / 100% |

The baseline phone layout shrank each bar differently: Central's 180 deliveries
looked smaller than North's 140. The first revision fixed that. The overview judge
continued to identify the missing 430 total, which guided the second revision.
All four evaluations share an evaluator fingerprint. The session is
`.agent-eval/marketing-video/dashboard-6qCjpf/`, sealed in `evidence.json`;
`loadEvidence()` verifies the retained files and binds each revision to its evaluated source hashes before rendering.
`assets/dashboard.html` retains the final page as a reference.

## Dispatch improvement session

Human feedback directed the original prototype retained in `assets/dispatch-baseline/`. The evaluated final revision is in `docs/marketing/dispatch/`. Its quality
targets (`improvement/next-example.md`) became five frozen criteria in
`improvement/dispatch/suite.yaml`:

- **Data** (gate): counts derive from the queue; the reassignment changes only the
  late shipment, respects cold chain and capacity, survives reload and is fully
  reversed by undo and reset. Deterministic browser check on desktop and phone.
- **Task** (gate): filters, empty search recovery, keyboard cancel and reopen,
  confirmation, undo and confirmed reset work end to end. Deterministic check.
- **Phone**: at 390px, no horizontal scrolling, no deliveries hidden in a nested
  scroll region, queue and option text at least 12px, task controls at least 40px.
- **Decision**: a dispatcher can see the exception, its cause and consequence, and
  compare constrained recovery options. Fresh Codex judgment, three to five votes.
- **Craft**: coherent, professional product finish across six screens. Fresh
  Codex judgment, three to five votes.

| Evaluated revision | Data | Task | Phone | Decision | Craft | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Human-directed prototype | Pass | Pass | Fail | Pass | Partial | 70% |
| Phone queue and option text | Pass | Pass | Pass | Pass | Partial | 90% |
| Type scale, contrast and map labels | Pass | Pass | Pass | Pass | Pass | 100% |
| Fresh repeat of the final revision | Pass | Pass | Pass | Pass | Pass | 100% |

The baseline phone queue showed 5 of 9 deliveries inside a 320px nested scroll,
with deadlines, statuses and eligibility notes at 9–11px. The judges also found
secondary text and map labels tiny and faint. Every run has complete coverage and
the same evaluator fingerprint. The session is
`.agent-eval/marketing-video/dispatch-bLOsT1/`.

The PHONE thresholds were written after a code review had noted the nested phone
queue, so they are agent-authored standards rather than an independent discovery.
The suite measures this fixed synthetic scenario; it does not establish general
judge accuracy, audience preference or operational value.

## Restore and render the recorded demonstration

From a fresh checkout, install dependencies and build the CLI:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
npm ci --prefix video/marketing
node video/marketing/recording.mjs restore
node video/marketing/references.mjs
```

The checked-in `assets/recording.json.gz` contains both recorded sessions, their
source snapshots, reports, comparisons, screenshots and manifests. Its checksum
is pinned in `assets/recording-index.json`. Restoration verifies every file and
refuses to overwrite a different existing file. It uses no provider calls and
replays historical evidence; it does not claim a new evaluation. The reference
command downloads the pinned creative references for the optional visual review
and the reference-integrity test.

```sh
node video/marketing/render.mjs --stills --main
node video/marketing/render.mjs
npm --prefix video/marketing test
python3 -m http.server 8766 --bind 127.0.0.1 --directory docs/marketing
```

Open <http://127.0.0.1:8766/video.html>. Select a cut and format, download MP4 and
captions, read the transcript or inspect the evidence. `example.html` compares
the original and final dispatch prototypes. Dashboard artifacts are retained for
the walkthrough. All demo actions stay in browser storage.

Rendering uses no providers. Each full export is written to a new immutable
release directory. Only after full decoding and verification does the renderer
atomically switch `exports/NAME` to that directory. A receipt binds the video,
poster, captions and stills to the evidence and composition inputs. The preview
is also staged as a complete release and switched only after every export passes.
A failed render leaves the previous release intact. `--stills` writes only to
`drafts/`, so draft captions and posters cannot replace published assets.

Use `--main`, `--social` or `--walkthrough` and optionally `--landscape` or
`--portrait` to render a subset. Run `node video/marketing/preview.mjs` after all
six exports match the current evidence and composition. Edit story and captions
in `src/story.mjs`; composition is in `src/Video.jsx`.

## Run a new improvement session

```sh
pnpm aek doctor --providers codex
node video/marketing/improvement/prepare.mjs dispatch
```

Preparation prints a new isolated session. Dispatch starts from the retained
original prototype, not the already-improved published design. Dashboard starts
from `examples/visual/index.html`. Both copy the frozen evaluation methods.
Substitute the printed path for `SESSION`; edit only its project target between
runs, based on actual findings:

```sh
node video/marketing/improvement/run.mjs SESSION baseline 'Evaluate the unchanged prototype.'
# Inspect the report, then change SESSION/project/dispatch/.
node video/marketing/improvement/run.mjs SESSION phone-queue 'Describe the actual phone change.'
# Inspect again, then make the next justified revision.
node video/marketing/improvement/run.mjs SESSION type-and-map 'Describe the actual craft change.'
node video/marketing/improvement/run.mjs SESSION repeat 'Reevaluate the unchanged final revision.'
```

Each run invokes a real subscription judge. A critical product failure exits 2;
execution errors remain errors. `run.mjs` snapshots the target before evaluating,
compares every file with the report's collector-source hashes, never overwrites a
label and journals every evaluation attempt. A concurrent edit that makes the
snapshot differ from the evaluated inputs is an execution error with no accepted
score. Both sealers and evidence loaders independently enforce this binding.

New results are not predetermined. If they differ from the recorded demonstration,
change the film's story. For dispatch, copy the final evaluated revision into
`docs/marketing/dispatch/` before capture. Capture requires unchanged evaluation
methods, complete coverage, a matching repeat and a passing final revision whose
score improves on the baseline:

```sh
node video/marketing/workflow.mjs DISPATCH_SESSION
# For a dashboard session use labels baseline, proportions, overview, repeat:
node video/marketing/evidence.mjs DASHBOARD_SESSION
```

The sealers write AEK comparisons and manifests; workflow capture includes the
baseline, intermediate phone revision and evaluated final product. Capture before
rendering. `loadWorkflow()` rejects a published prototype that differs from the
evaluated final revision. To retain a reviewed replacement recording for fresh
checkouts, explicitly run `node video/marketing/recording.mjs pack` and review the
changed archive and checksum together. Keep historical observations intact;
restoring the bundled recording must never be used to conceal a failed new run.

The broader functional check covers six viewport widths, constraints,
persistence, undo, filtering and visible errors:

```sh
node video/marketing/improvement/prototype-check.mjs http://127.0.0.1:8766/
```

## Creative references

| Reference | What informed the cut |
| --- | --- |
| [Cursor × Linear](https://linear.app/agents) | A recognizable action, visible work, and a reviewable result. |
| [Introducing Linear Agent](https://linear.app/changelog/2026-03-24-introducing-linear-agent) | Tight framing, restrained typography and focal hierarchy. |
| [Langfuse Prompt Experiments](https://langfuse.com/changelog/2024-11-22-prompt-experimentation) | Keep the same evaluation task visible from input to comparison. |
| [LangSmith Regression Testing](https://www.langchain.com/blog/regression-testing) | Move from a changed result to its supporting evidence. |

The two Linear films were reviewed through sampled frames; the Langfuse and
LangSmith references use their official walkthrough descriptions. These are
curated targets, not an objective conversion ranking. No reference footage is
included. The pinned Linear and AlphaEvolve files remain available for
comparative still assessment through `references.json` and `references.mjs`.

## Verification

```sh
npm --prefix video/marketing test
node video/marketing/smoke.mjs http://127.0.0.1:8766/video.html
pnpm aek validate --config video/marketing/evalkit.yaml
```

Tests verify the narrative order, scores and findings against retained reports,
captured dispatch facts, that the published prototype is the evaluated final
revision, reference integrity, full decoding, all six delivery contracts and
render hashes. The browser smoke test checks all six files, cut/format selection,
captions, transcripts, evidence links and narrow-screen layouts. Accelerated
playback is an operational check, not creative approval.

Integrity regressions are covered by
`npm --prefix video/marketing run test:integrity`: concurrent edits, complete
source binding, original-baseline preparation, clean-checkout restoration,
corrupted archives, incomplete releases, changed captions/posters and stale
composition inputs. The full test command also checks the six rendered exports.
Playback checks establish operation, not creative approval or reading time.

An optional model review assesses sampled images of the **60-second main film**
against a demanding craft bar and the bounded claims above:

```sh
pnpm aek run --config video/marketing/evalkit.yaml --fail-under-coverage 100
```

It uses sequential `gpt-6-astra` medium votes: three initially, at most five, with
0.8 agreement. Inconclusive outcomes reduce coverage; corrupt inputs are execution
errors. It does not assess continuous motion or the other cuts, and a pass does
not establish marketing effectiveness. **It has not been run for this version**;
earlier reviews of previous cuts are retained under
`.agent-eval/marketing-video/eval-runs/` and do not apply.

Before publication, watch the complete films at normal speed and test the rough
cut with unfamiliar developers: what does AEK do, who makes the edit, how the
standards and feedback guided successive improvements, and what should they do
next? Keep that audience feedback separate from delivery tests and model
judgments.
