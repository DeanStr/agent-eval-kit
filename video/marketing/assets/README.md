# Film assets

`dashboard.html` is the earlier overview revision of the existing `examples/visual/index.html`
delivery-dashboard sample. It was developed in response to actual AEK findings:
correct phone chart proportions, then add a computed overview and responsive
hierarchy. The data is synthetic. The original, intermediate and final bytes are
retained in the captured session; the film uses their actual browser screenshots.
This asset is a reference copy of that intermediate endpoint. The film's after is
the dispatch prototype in `docs/marketing/dispatch/`: the final revision evaluated
by its own AEK suite, then captured by `workflow.mjs` with synthetic records and
actual reassignment interactions.

`InterVariable.woff2` is Inter 4.1 by Rasmus Andersson, downloaded from
https://rsms.me/inter/font-files/InterVariable.woff2?v=4.1. Its SIL Open Font License
is included in `Inter-LICENSE.txt`. The renderer embeds the font and waits for it
before capturing frames; it makes no runtime network requests.

`dispatch-baseline/` retains the exact original dispatch prototype from the
recorded 70% evaluation. `improvement/prepare.mjs dispatch` starts here; the final
published revision remains in `docs/marketing/dispatch/`. No defects were added to
construct this baseline. Its font uses the same Inter license above.

`recording.json.gz` contains the historical evidence needed to render from a fresh
checkout: both sessions' source snapshots, reports, comparisons, browser captures,
and manifests. `recording-index.json` pins its checksum. Run
`node video/marketing/recording.mjs restore` to restore missing files without
overwriting any existing session. Restoring is offline replay, not a new evaluation.
The archive is a gzip-compressed versioned JSON file with base64 file contents and
per-file SHA-256 hashes. Regenerate it explicitly with `recording.mjs pack` only
after sealing and reviewing a new recording.
