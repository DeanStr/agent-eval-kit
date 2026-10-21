# Compare image files

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
| `--capacity-retries n` | Retries for explicit temporary judge capacity failures, integer 0–5; default `2`. |
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
[visual evaluation workflow](visual-evaluation.md). `image compare` evaluates one
pair per invocation; use `image batch` below to coordinate many pairs.


## Batch comparisons

`aek image batch` accepts a JSON manifest and writes one combined `report.html`
and `report.json`, plus the ordinary sealed run and full vote report for every
pair. It validates and decodes **every** pair before starting model calls.
Image paths resolve relative to the manifest, not the shell working directory.

```json
{
  "version": 1,
  "defaults": {
    "judge": "codex",
    "judgeModel": "gpt-6.1-sol",
    "judgeEffort": "high",
    "policy": "preference",
    "criterion": "Typography, spacing, alignment and grouping are visually clearer.",
    "absoluteCriterion": "Text is readable and controls have clear visual hierarchy.",
    "voting": { "minimumVotes": 5, "maximumVotes": 5, "agreement": 1 },
    "capacityRetries": 2
  },
  "comparisons": [
    {
      "id": "applications-desktop",
      "label": "Applications · desktop",
      "candidate": "after/applications.png",
      "reference": "before/applications.png",
      "panel": { "width": 1280, "height": 800 }
    },
    {
      "id": "directory-mobile",
      "candidate": "after/directory-mobile.png",
      "reference": "before/directory-mobile.png",
      "panel": { "width": 390, "height": 844 }
    }
  ]
}
```

```sh
aek image batch --manifest comparisons.json --dry-run --json
aek image batch --manifest comparisons.json --concurrency 2 --output review-01
aek image batch --resume review-01
aek image batch --manifest revised-comparisons.json --reuse review-01 --output review-02
```

Use 1–1000 comparisons with unique portable IDs (letters, digits, underscores
and hyphens, starting with a letter or digit; at most 80 characters). All image
settings shown for `image compare` are available in `defaults` using camelCase
JSON names, and each row can override them. Overrides replace whole settings:
for example, a row's `voting` object receives the normal voting defaults, rather
than merging individual fields from the manifest's default voting object.
`candidate` and `reference` are required per row, and `criterion` must be supplied
per row or in defaults. `label` is optional report text and never enters judging.

`--concurrency` bounds simultaneous comparisons from 1–8 (default 2); each pair's
votes and optional absolute checks remain sequential. On an execution error the
queue stops assigning new pairs, lets active healthy pairs finish, and retains
errors and pending rows in the combined report. A failed quality gate or split
vote does **not** stop remaining comparisons. Exit codes are 0 only when every
pair passes, 2 for completed failed/inconclusive gates, and 1 for execution errors.
Signal interruptions use 130/143.
Completed results are loaded before the queue starts, so an execution error does
not hide later retained outcomes or mark them as pending.

Resume accepts **only** `--resume`; it uses retained image copies and settings,
so the manifest and original screenshots may be removed. It preserves completed
votes and completed results. Concurrent batch writers are rejected; a stale lock
requires confirming all original processes have exited before manual removal.
Resume can reclaim an empty child reservation left by failed initialization.
A child directory containing artifacts without run state fails explicitly and
retains its files for diagnosis.

Reuse accepts one prior native batch. It verifies retained inputs and completed
run seals, and copies completed matches, including negative and inconclusive
results. Output must be outside the prior batch, including when paths resolve
through symlinks. Identity includes exact original image bytes, criteria, policy, voting,
panel settings, provider/model/effort, timeout/retry settings, CLI version, AEK
and visual-method versions, Node and image-engine versions. Labels, IDs, original
file locations, output paths and batch concurrency do not affect judging identity.
Matches are one-to-one: unchanged IDs retain their own completed results first,
then renamed rows use remaining matching results in prior manifest order. Each
prior result is reused at most once, so duplicate comparisons keep their distinct
outcomes; additional rows receive new comparisons when no unused match remains.
Changed contracts receive new comparisons. This feature does not use a pixel-noise
tolerance or import results from project-specific wrappers. Resumption and reuse
never reroll an existing split decision to seek a passing result.

The combined report and retained artifacts are sealed. Verify the batch with
`aek verify --run review-01`; editing its totals or evidence fails integrity
verification and prevents resume/reuse.

The HTML report includes PNG previews, original downloads, criteria, per-check vote counts and
links to full reasoning and evidence. Counts distinguish pending work, execution
errors, failed/inconclusive comparisons and passed comparisons. All configured
gates must pass before the batch is accepted; observed equivalence satisfies only
`non_regression`. Choose suitable panel dimensions; the existing contain/cover
normalization may resize images.

## Temporary provider capacity failures

Direct image commands default to two capacity retries; disable them with
`--capacity-retries 0` or manifest `capacityRetries: 0`. Other evaluation suites
can opt in with `judge.capacityRetries: 2` (default: no retries).
This applies to judge invocations, including absolute rubric checks and text
judges, never scenario collection.

Only nonzero exits with an explicit temporary capacity/overload diagnostic and
no completed assistant response or structured-output call qualify.
Authentication/billing/quota errors, generic rate limits, timeouts, policy
violations, malformed responses and actual verdicts are
not retried. Backoff is 1, 2, 4, 8 and 16 seconds for up to five retries, and can
be interrupted. Each failed retry attempt keeps its result, events, stderr and
inspection transcript under the vote's `capacity-retries/attempt-N/`; the fixed
prompt, image order and completed votes remain unchanged. Exhaustion remains an
execution error with normal resume recovery. Existing incomplete-vote recovery
can replace an unfinished vote's diagnostics; completed vote artifacts remain
sealed.
