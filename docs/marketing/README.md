# Autonomous improvement visual

Open `index.html` in a browser for the interactive terrain illustration. Select a
revision, use the previous/next buttons, or play the six-revision story. The demo
runs locally with no external assets, dependencies, or provider calls.

GitHub displays HTML source rather than running the demo. From this checkout,
serve the preview directory and open <http://127.0.0.1:8766/index.html>:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory docs/marketing
```

To reach it over Tailscale, bind to this machine's Tailscale IP instead of
`127.0.0.1` and use that IP in the URL. Choose an unused port if 8766 is occupied.

Playback narrates preparation, evaluation, and selection over 30 seconds for the
full story. Scores stay pending until the evaluation finishes; the best accepted
score advances only for accepted candidates. Pause/resume preserves the current
phase and remaining time. Selecting a checkpoint exits playback and opens its
result. The compact mobile illustration fits the full terrain on screen.

- `hill-climbing.svg`: scalable README and presentation graphic.
- `hill-climbing.png`: rendered graphic for sharing.
- `references.html`: attributed visual research, with images loaded from the
  original publishers (requires internet access).
- `build_visual.py`: standard-library Python generator for the original terrain,
  illustration, and embedded SVG. Run it to regenerate both vector copies.

The scores, findings, coverage, and agent decisions are illustrative, not measured
project results. The coding agent or external orchestration owns editing and
candidate selection. AEK supplies evaluations, evidence, comparisons, coverage,
and critical gates. The landscape is conceptual, not a measured score surface.
The unscored revision sits outside the terrain.

Edit `build_visual.py` to change the illustration, then run:

```sh
python3 docs/marketing/build_visual.py
pnpm exec playwright screenshot --viewport-size="1600,1040" \
  "file://$PWD/docs/marketing/hill-climbing.svg" docs/marketing/hill-climbing.png
```

The generator updates the SVG inside the HTML's `illustration:start` and
`illustration:end` markers. Page layout and interactions live in `index.html`.

Run the focused checks with `node scripts/marketing-smoke.mjs`. They require
Python 3 and the project's Playwright Chromium, run without network access, and
verify generation in a temporary directory without rewriting the source assets.

The reference direction combines the landscape metaphor in
[DeepMind's AlphaEvolve artwork](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/),
the result hierarchy of [LangSmith Evaluations](https://www.langchain.com/langsmith/evaluation),
and the visible search history in [Sakana AI's DGM archive tree](https://sakana.ai/dgm/).
The AEK terrain, route, and illustration are original vector work; no reference
imagery is included in the demo or exports.

The silent 100-second Remotion film has 16:9 and 4:5 exports. Open
[the video preview](video.html) after rendering; see
[video build, references, and eval instructions](../../video/marketing/README.md).
