# Silent hill-climbing video

A 100-second Remotion film for LinkedIn, X, and Reddit. Two separately composed
exports: **1920×1080 (16:9)** and **1080×1350 (4:5)**, 30 fps, H.264, no audio track.
The coding agent edits and selects; AEK evaluates, compares, and returns evidence.
The storefront, user story, code and scores are illustrative. No reference footage is
included in the delivered film.

## Build and preview

From the repository root, install the root dependencies (`pnpm install`) and
Playwright Chromium (`pnpm exec playwright install chromium`) if not already
available. The separate video package keeps Remotion out of AEK's runtime deps.

```bash
npm ci --prefix video/marketing
node video/marketing/render.mjs
node video/marketing/references.mjs
npm --prefix video/marketing test
```

The renderer embeds the original lamp image and licensed Inter variable font from
`assets/`, waits for font loading, and uses the installed monospace font for the
illustrative patch. No network requests are needed during rendering. Extraction requires
FFmpeg/ffprobe, Sharp, and libvips versions recorded in `toolchain.json`; a mismatch
fails with the actual and expected versions. Review extraction changes before
updating that file. Dependencies are locked separately for Remotion and AEK.

Outputs live in `.agent-eval/marketing-video/`: `landscape.mp4`, `portrait.mp4`,
story stills, reference samples, and evaluation runs. `render.mjs` publishes a
local preview under `docs/marketing/video-output` (ignored). Serve
`docs/marketing` and open `video.html`. The existing Tailscale preview is
`http://100.74.32.71:8766/video.html` while its local server is running.

For a faster composition pass, use `node video/marketing/render.mjs --stills`.
Use `--landscape` or `--portrait` to render just one format, then run
`node video/marketing/preview.mjs` to refresh the preview once both exports exist.
Each completed MP4 replaces the previous file atomically. Do not render over
candidate files during an evaluation; AEK rejects source changes during a run.

Edit copy and scene boundaries in `src/story.mjs`; edit composition and animation
in `src/Video.jsx` and `src/visuals.jsx`. Motion is driven by Remotion frames:
quantity changes, cursor movement and click feedback, the failed-total annotation,
a code patch, a successful retest and order confirmation, judge expansion, and a
returning loop. The same fictional storefront stays recognizable throughout. Contextual close-ups
isolate quantity and totals, the evidence overlay, and the checkout summary.
Asymmetric landscape compositions, subtle perspective, a light edit stage, and
a larger closing loop vary the framing without changing the underlying story.
Checkout fills the frame in both formats, and payment ends on a photographic
confirmation. After selection, US-02 visibly searches for “aluminum” and returns
the lamp, making the next evaluation explicit.


## Reference films

`references.json` records official source pages, direct media URLs, SHA-256 hashes,
file sizes, chosen timestamps, and each reference's specific comparison role.
`references.mjs` downloads missing files and verifies cached files; changed
reference bytes require deliberate review, never silent substitution. Files stay
in ignored local artifacts. Original reference audio is not evaluated or reused.

| Official film | Comparison target | Limits |
| --- | --- | --- |
| [Introducing Linear Agent](https://linear.app/changelog/2026-03-24-introducing-linear-agent) | Deliberate framing, focal hierarchy, restrained palette, visual finish | Its small UI type is not our social-feed legibility target. |
| [Cursor × Linear](https://linear.app/agents) | Concrete workflow progression, sparse staging, clear outcome and brand close | Our fictional storefront demonstrates an original journey; no reference UI is copied. |
| [AlphaEvolve code evolution](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) | Continuity of exploration and candidate selection | Dense code is conceptual context, not a readability benchmark. |

These are curated creative targets, not a claim of an objective global ranking.
A Linear AI hero loop was also inspected but excluded: it adds less narrative
coverage than the three selected films. Reference contact sheets can be found in
`.agent-eval/marketing-video/references/*-board.png`.

## Evaluate

Render both candidates and prepare references first, then:

```bash
pnpm aek validate --config video/marketing/evalkit.yaml
pnpm aek run --config video/marketing/evalkit.yaml --fail-under-coverage 100
```

One ordinary LLM area batches **both formats and all four visual criteria**.
Every fresh judgment uses **`gpt-6-astra` with medium reasoning**. Voting starts at
**3** and expands to at most **5** if any criterion or case lacks agreement. Votes
are sequential, so there is never more than one active judge. This stays below
the requested limit of three at a time; `judge.concurrency` only parallelizes
image-pairwise workers and does not change ordinary vote scheduling. There are no
pairwise graders or separate judge calls per reference.

Agreement is 0.8: unanimous three stops; a 2–1 split can resolve at 4–1 after five.
A 3–2 split, abstentions, or insufficient confidence remain inconclusive and
reduce coverage. Invalid provider output and missing/corrupt inputs are execution
errors. Command collection and technical grading use no model calls.

The collector samples sealed candidate and reference MP4s, preserving provenance.
The rubric evaluates sampled narrative, native feed-width text, and comparative
visual craft. The separate delivery gate verifies full decoding, duration, frame
count, dimensions, codec/pixel format, and the absence of audio.

**A passing sampled-image eval is not continuous-motion approval.** Before
publishing, play both full exports at normal speed to review reading time,
transitions, and any transient visual defects. Do not interpret automated scores
as proof of smooth animation. This limitation also applies to reference films.

Provider requests, individual votes, confidence, evidence references, and final
reports are retained under `.agent-eval/marketing-video/eval-runs/`.


## User-story cut

The checkout sequence follows US-01: a shopper changes quantity and pays the correct
total. Two $120 lamps initially produce a broken $120 total. AEK returns a
screenshot and failed assertion, the coding agent revises the calculation, and
the same story passes at $240. An independent panel assesses subjective checkout
clarity; it does not vote on arithmetic. Revision selection illustrates a
critical gate, followed by an animated search journey and a withheld refund
score when its provider is unavailable.

Twenty-three samples per format include the failed cart, patch, corrected cart, order
confirmation and both panel sizes. The 29 evidence images stay within the judge's
2,000-pixel attachment limit. `USER_STORY` requires observable interface behavior;
`CRAFT` is now a critical gate with a demanding comparison against the pinned
Linear films. Clear generic diagrams alone cannot pass either bar. This change
responds to human feedback that the earlier diagram cut passed automated checks
but lacked specificity and visual polish.

The previous 70-second diagram exports are preserved locally under
`.agent-eval/marketing-video/checkpoint-expanded/`. The earlier calibration and rejected-cut assessments are retained under
`calibration/`; the original
40-second committed checkpoint remains under `checkpoint-05d7419/`.

## Continuous-workflow cut (100 seconds)

The terrain opens the film (0–8s), explicitly connecting AEK to improving your coding
agent’s work on your project. The storefront is introduced as an example project
with “Your agent built this”; AEK remains the evaluation layer throughout the demo. The checkout failure is inspected immediately
(21–27s), before the agent fixes the code and the retest confirms payment.
The inspector links the failed screenshot, assertion log and illustrative source
snapshot. It no longer revisits an unexplained failure after the successful retest.

From 37–77s, `src/Workflow.jsx` keeps one product carrier mounted through criteria,
evidence collection, subjective judging, gated selection, the returning agent loop,
and a blocked refund scenario. The carrier changes from the photographed cart to its
assertion log, a close-up of the payable total, confirmation, and the next code edit.
The enlarged loop keeps that evidence prominent while it moves between owners. A shared continuous clock moves the carrier between
stages; it does not fade out and restart at each scene boundary. The loop physically
returns the candidate to the coding agent for the next revision. The blocked
attempt leaves the accepted best at 82.

The final terrain (82–94s) expands on the opening: the gate-failing 77 branch leaves
the accepted baseline at 68, the unknown branch leaves it at 82, and collected
evidence allows the next accepted 91. Rejected and withheld attempts remain visible
as context instead of appearing as improvements. The original terrain is extracted
from `docs/marketing/hill-climbing.svg` by `terrain.mjs`.

The previous approved 100-second film and source are preserved in
`.agent-eval/marketing-video/checkpoint-hill-first-100/`. The previous 82-second
cut remains in `checkpoint-combined-82/`; the earlier approved 70-second checkout
film remains in `checkpoint-user-story-approved/`.

Twenty-three timestamps are grouped into twelve native-width panels per format;
eleven panels contain two vertically stacked frames. Five-column overview boards
keep all 29 attachments under the judge's 30-image and 2,000-pixel limits. The
collector fails if an attachment exceeds those dimensions. Scene timing is
sealed as a collection/grading dependency. Parallel per-format rendering uses
separate bundle directories; refresh `preview.mjs` after both formats finish.
