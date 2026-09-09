# Silent hill-climbing video

A 40-second Remotion film for LinkedIn, X, and Reddit. Two separately composed
exports: **1920×1080 (16:9)** and **1080×1350 (4:5)**, 30 fps, H.264, no audio track.
The coding agent edits and selects; AEK evaluates, compares, and returns evidence.
All scores and the search landscape are illustrative. No reference footage is
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

The Linux renderer uses installed DejaVu Sans/Mono fonts. Extraction requires
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
in `src/Video.jsx`. Motion is driven by Remotion frames: route reveals, checkpoint
pulses, camera scale, and text entrances. The terrain comes from the original
`docs/marketing/hill-climbing.svg`, rasterized once for rendering performance.

## Reference films

`references.json` records official source pages, direct media URLs, SHA-256 hashes,
file sizes, chosen timestamps, and each reference's specific comparison role.
`references.mjs` downloads missing files and verifies cached files; changed
reference bytes require deliberate review, never silent substitution. Files stay
in ignored local artifacts. Original reference audio is not evaluated or reused.

| Official film | Comparison target | Limits |
| --- | --- | --- |
| [Introducing Linear Agent](https://linear.app/changelog/2026-03-24-introducing-linear-agent) | Deliberate framing, focal hierarchy, restrained palette, visual finish | Its small UI type is not our social-feed legibility target. |
| [Cursor × Linear](https://linear.app/agents) | Concrete workflow progression, sparse staging, clear outcome and brand close | Our terrain can tell the story without imitating its UI footage. |
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

One ordinary LLM area batches **both formats and all three visual criteria**.
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
