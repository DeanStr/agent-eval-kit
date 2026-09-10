# Compare two image files

Use `aek image compare` to check whether a proposed design, screenshot, chart, or
illustration is at least as good as a reference on a criterion you supply. You
need two local images and a logged-in judge CLI; no project config, browser,
collector script, or source checkout is required. With a local package installation,
use `npx aek` or `pnpm exec aek`; in this repository use `pnpm aek`.

```bash
aek image compare \
  --candidate ./new-dashboard.png \
  --reference ./approved-dashboard.png \
  --criterion "Labels are readable and the revenue trend is easy to understand."
```

The default judge is Codex. Use `--judge claude` or `--judge grok` to select another
installed, authenticated provider. This runs paid/subscription model calls under
your provider account. First preview the resolved inputs and voting settings with
`--dry-run --json`: it validates and decodes both files without invoking a provider
or creating output. `--judge mock` exercises the workflow offline and always
abstains; its result is inconclusive and exits 2.

## Decide what passing means

The default `--policy non_regression` passes when the candidate wins or the judge
observes equivalence. `--policy preference` requires the candidate to win;
equivalence fails. Abstention or insufficient voting agreement is inconclusive
and reduces coverage under either policy.

A relative win alone does not establish acceptable quality. Add a separate
candidate-only requirement when both relative and absolute quality matter:

```bash
aek image compare \
  --candidate ./new-chart.png \
  --reference ./old-chart.png \
  --criterion "The chart communicates the monthly trend more clearly." \
  --policy preference \
  --absolute-criterion "Every axis has a legible label and visible unit, and the legend is readable." \
  --output ./chart-review
```

Both requirements become critical gates. A failure or an inconclusive result in
either prevents a successful exit. Supply criteria the pixels can establish:
checking underlying values or interactive behavior requires additional evidence.

## Read and retain the result

The command prints the comparison directory, HTML report, run directory, verdict,
and coverage. The default output lives beneath `.agent-eval/image-comparisons/`;
`--output` selects a **new** directory and never overwrites an existing one.

The directory contains copies of both original images, their hashes and original
paths in `comparison-inputs.json`, and a generated `evalkit.yaml`, spec, and
collector. Its `.agent-eval/runs/<run-id>/` directory contains the ordinary AEK
report, sealed evidence, blind comparison panels, individual votes, reasoning,
findings, and image diagnostics. Panel A/B ordering is randomized per vote to
reduce position bias. These are semantic judgments against your criterion;
image statistics are diagnostic, not an automatic pixel-difference pass threshold.

Exit codes are `0` for satisfied gates, `2` for failed or inconclusive gates, and
`1` for invalid inputs or execution errors. A broken judge invocation is an
execution error, not a low quality score. Repeated agreement measures consistency;
calibrate criteria with examples you know should pass and fail.

Use the printed run path with standard tools:

```bash
aek verify --run /path/to/comparison/.agent-eval/runs/RUN_ID
aek run --resume /path/to/comparison/.agent-eval/runs/RUN_ID
```

After a judge failure, the retained run is under the printed comparison directory's
`.agent-eval/runs/`. Resume reuses completed collection and votes when the generated
inputs still match. Keep the generated config, scripts, and `sources/` directory
alongside the run; the original input files may be moved or deleted. Use a new
comparison for changed images or criteria. Standard [evidence workflows](evidence-workflows.md)
and [report review commands](cli.md#execute-recover-and-review) also apply.

## Options

| Flag | Meaning / default |
| --- | --- |
| `--candidate file` | Required local image to evaluate. |
| `--reference file` | Required local image to compare against. |
| `--criterion text` | Required relative quality requirement. |
| `--absolute-criterion text` | Optional independent candidate-only requirement; uses repeated rubric judging. |
| `--policy non_regression\|preference` | Default `non_regression`. |
| `--judge codex\|claude\|grok\|cursor\|mock` | Default `codex`. |
| `--judge-model id` | Provider-specific model; otherwise the provider default. |
| `--judge-effort value` | Provider-specific reasoning effort. |
| `--timeout-seconds n` | Positive integer provider-invocation timeout in seconds; default `900`. |
| `--minimum-votes n` | Minimum votes per comparison/check; integer 1–25, default `5`. |
| `--maximum-votes n` | Maximum votes; integer 1–25 and at least the minimum, default `9`. |
| `--agreement fraction` | Required agreement greater than 0.5 and at most 1; default `0.8`. |
| `--minimum-confidence fraction` | Confidence floor between 0 and 1; default `0.55`. |
| `--width pixels`, `--height pixels` | Comparison panel dimensions, integers 1–2000; default 1280 × 800. |
| `--output new-directory` | Directory holding retained inputs, generated setup, and run. |
| `--dry-run` | Validate and preview without output or provider calls. |
| `--json` | Machine-readable preview; requires `--dry-run`. |

PNG, JPEG, WebP, single-frame GIF/TIFF, AVIF/HEIF, and SVG are accepted when the
installed image decoder supports them. Each input must be a regular local file
at most 25 MiB and at most 40 million decoded pixels. The candidate must also fit
within 25 MiB after conversion to lossless PNG evidence. A highly detailed JPEG
can exceed this limit even when its original file fits; resize it explicitly
before comparing. The command checks this during preflight, including dry runs.
Unsupported, corrupt,
animated, and multipage images fail before output is created; extract the intended
frame or page first. Paths resolve from the current working directory. URLs are
not accepted.

AEK applies orientation, flattens transparency onto white, and preserves decoded
candidate evidence as lossless PNG. Comparison panels contain each image within
the configured dimensions against white, preserving aspect ratio without cropping.
Choose a suitable panel size for small text. Originals remain available for review.

For multiple references, crops, image baselines, browser capture, motion checks,
or deterministic regression thresholds, use the configurable
[visual evaluation workflow](visual-evaluation.md). This command evaluates one
pair per invocation.
