# Visual evaluation and repeated judging

AEK supports controlled browser capture, deterministic checks, blind image comparisons, and repeated rubric judgements over fixed evidence. These capabilities use the existing providers, coverage rules, run lock, integrity index, reports, and baseline promotion. The design was informed by the visual evals in `DeanStr/traffic`; game-specific setup and metrics remain project-owned.

## Try the example

```bash
pnpm aek validate --config examples/visual/evalkit.yaml
pnpm aek run --config examples/visual/evalkit.yaml --judge codex
```

The example manages a local server and captures a dashboard with a small project adapter. The collector does not invoke an agent. `--judge codex` uses the configured subscription; Claude and Grok also support pairwise images through the evidence MCP. Omitting `--judge` uses the offline mock, which abstains on every image comparison: the deterministic checks can pass, but the visual gate stays unavailable and the command exits 2. Mock output is never evidence of visual quality.

## Controlled browser capture

Add `capture` to a browser scenario:

```yaml
scenarios:
  - id: CHART
    name: Seeded chart
    kind: browser
    instructions: Capture a stable chart and its updates.
    capture:
      hook: __AEK_EVAL__
      seed: 1337
      setup: { dataset: quarterly }
      readySelector: canvas
      timeoutSeconds: 60
      passes: 2
      frames: 4
      stepSeconds: 1
      channelTolerance: 0
      maximumChangedPixelRatio: 0
      movementChannelTolerance: 2
      minimumMovement: 0.001
      metrics:
        rendering.errors: { max: 0 }
        jobs.completed: { min: 10 }
```

The page must expose the named object with these methods:

```js
window.__AEK_EVAL__ = {
  async reset() {},
  async setSeed(seed) {},
  async configure(settings) {},
  async waitUntilStable() {},
  async advance(seconds) {},  // required when frames > 1
  async getMetrics() {        // required when metric checks are configured
    return { rendering: { errors: 0 }, jobs: { completed: 10 } };
  }
};
```

Each pass starts a new browser/context, restores the same captured persona if configured, calls reset → setSeed → configure, and collects frames after waitUntilStable and a two-frame compositor barrier. Case variables override same-named setup fields. Finite CSS animations are disabled for screenshots; application time advances only through the adapter. Controlled scenarios cannot depend on other scenarios: their state must be established by reset/configure. Existing authentication rules still apply.

The timeout covers the whole controlled scenario. Missing methods, missing/non-numeric required metrics, invalid images, renderer mismatches, timeouts, and cancellation are execution errors. Failed numeric thresholds and repeatability checks remain observed product/check failures. Adapter metrics are explicitly marked as instrumented evidence; they are not independent proof that the app's implementation is correct.

AEK retains lossless PNGs for every pass/frame, contact sheets, pixel difference images between passes, metrics, image statistics, diagnostics, and browser provenance. First-pass screenshot labels are `frame-001`, `frame-002`, etc., and `contact-sheet`. Later labels include the pass prefix, such as `pass-02/frame-001`. Pixel repeatability and exact metric repeatability cover every frame.

If capture fails partway through a pass, `capture.json` retains that pass's collected frames and measurements for investigation. Controlled evidence also retains its configured persona.

Optional capture settings:

| Setting | Meaning |
|---|---|
| `minimumMovement`, `maximumMovement` | Bounds on changed-pixel ratio between successive temporal frames |
| `channelTolerance`, `maximumChangedPixelRatio` | Repeatability: per-channel noise tolerance (0–255) and maximum changed-pixel fraction across independent passes; both default to zero |
| `movementChannelTolerance` | Independent temporal per-channel noise tolerance (0–255, default zero); never inherits `channelTolerance` |
| `movementCrop` | Optional normalized region for temporal motion and duplicate checks; repeatability still covers the full frame |
| `minimumEntropy`, `minimumStdev` | Record failed checks below explicitly chosen image-information limits |
| `rejectDuplicateFrames` | Require consecutive frames to differ within the movement crop and tolerance |
| `imageHealth` | Optional source-image metric bounds, luminance levels, and crop; see below |
| `renderer: software` | Launch Chromium with SwiftShader for controlled WebGL capture |
| `rendererPattern` | Require the observed WebGL renderer to match a regular expression |

Blank/duplicate/motion checks are opt-in. Unchanged content and plain backgrounds can be valid. Movement alone does not prove correct behavior. Entropy, standard deviation and gradient energy are retained as diagnostics; they never automatically contribute quality points.

A pixel counts as changed when **any** RGB channel differs by **more than** the selected tolerance. For example, `channelTolerance: 0` requires exact repeatability, while `movementChannelTolerance: 2` prevents one- or two-level color fluctuations from satisfying a movement assertion. `rejectDuplicateFrames` uses this same temporal definition, not encoded-file equality. Image-health and duplicate threshold failures are observed check failures, not execution errors; corrupt images and invalid adapters remain execution errors.

Score the checks with a dedicated rubric:

```yaml
rubric:
  - id: REPRODUCIBLE
    criterion: Reproducible rendering and valid metrics
    weight: 1
    scenarios: [CHART]
    grader: { type: capture }
    gate: true
    passCriteria: Every configured capture check passes.
```

## Image health

Add optional metric bounds to a controlled scenario. The following thresholds are illustrative, not recommendations for all applications:

```yaml
capture:
  imageHealth:
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
    darkLevel: 8
    highlightLevel: 247
    metrics:
      darkPixelFraction: { max: 0.9 }
      highlightPixelFraction: { max: 0.9 }
      largestDarkRegionFraction: { max: 0.6 }
      largestHighlightRegionFraction: { max: 0.6 }
      gradientEnergy: { min: 0.15 }
```

Each metric accepts `min`, `max`, or `equals`; at least one bound is required. Health checks run on every frame in every pass and feed the `capture` grader. The run retains measurements, actual values, and expected bounds in `capture.json` and evidence; failed checks appear in the report.

Measurements use oriented, white-flattened source pixels converted to grayscale, cropped before measurement, with no resizing or comparison-panel padding. Dark pixels have grayscale values **≤ darkLevel**; highlights are **≥ highlightLevel**. Levels are integers with `0 <= darkLevel < highlightLevel <= 255`. Region fractions use four-connected neighbors (diagonal contact does not join regions), divided by all pixels in the measured region. Dark and highlight fractions count all qualifying pixels, regardless of connectivity.

Supported metrics are `entropy` (grayscale histogram bits, 0–8), `stdev` (population standard deviation of grayscale values), `gradientEnergy` (mean absolute horizontal/vertical neighbor difference), and the four pixel/region fractions above. They can expose missing renders or large obscured areas. Dark themes, night scenes, white documents, and intentional empty states need their own expectations. These values are not measures of aesthetic quality.

## Scoped image distinctness

An `image-distinctness` rubric explicitly selects captures that should differ. It works with controlled or ordinary browser screenshots and does not call a judge model:

```yaml
rubric:
  - id: DATASETS_DIFFER
    criterion: Dataset selection changes the visible chart
    weight: 1
    scenarios: [WEEKLY, MONTHLY]
    gate: true
    grader:
      type: image-distinctness
      candidate: frame-001
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }
      minimumDistance: 0.01
    passCriteria: Every pair of selected chart regions differs by at least 0.01.
```

`candidate` is an exact screenshot label in each referenced scenario. Every unordered pair in this group is compared; screenshots outside the group are ignored. Matrix cases expand into group members. Groups require 2–100 materialized scenarios before split selection. A split leaving fewer than two members produces `cannot_judge`, not a vacuous pass.

The method orients, flattens, and crops each source, resizes it to a 32×32 RGB thumbnail with `fit: fill`, and computes mean absolute channel difference divided by 255. Distance is in [0,1]; the required `minimumDistance` is in (0,1]. Equality with the threshold passes. Color is retained, but fine details and original aspect ratios are not. Select regions that express the expected distinction; thumbnail similarity cannot establish semantic equivalence or correct setup.

The report links cropped images, all pair distances, thresholds, and missing members. All pairs must pass. Missing ordinary-agent screenshots or blocked scenarios make the group unavailable. Invalid controlled-capture labels, required screenshots missing from completed controlled captures, ambiguous labels, corrupt images, or changed sealed evidence abort execution. A repeated scenario reference is invalid.

Deterministic visual graders run before model judges. Distinctness retains only small comparison signatures in memory while processing source images sequentially. Both new graders score their rubric group as a whole; they retain per-pair/per-scene diagnostics without inventing independent case scores for campaign strata.

## Image-statistic baseline checks

Pairwise comparisons automatically retain unscored source-image measurements and absolute/relative changes in `diagnostics.json`, plus a complete rubric cohort in `statistics.json`. The HTML comparison links both. No statistic changes the model's verdict. This is the diagnostic-only path; it requires no statistic thresholds.

To make project-validated statistic bounds into deterministic assertions, add an `image-regression` rubric. First create and review a run without this baseline-dependent rubric, promote it with `--include-images`, then add the rubric:

```yaml
rubric:
  - id: IMAGE_DETAIL
    criterion: Accepted chart detail remains within measured bounds
    weight: 1
    scenarios: [WEEKLY, MONTHLY]
    gate: true
    grader:
      type: image-regression
      candidate: frame-001
      baseline: approved
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }
      darkLevel: 8
      highlightLevel: 247
      metrics:
        entropy:
          change: relative
          minimumBaseline: 0.01
          mean: { min: -0.08 }
          perScene: { min: -0.2 }
        darkPixelFraction:
          change: absolute
          perScene: { max: 0.05 }
    passCriteria: All configured bounds pass for the complete matched cohort.
```

Baseline images match each materialized scenario ID and the exact `candidate` label. Their bytes are verified and snapshotted before collection, using the same receipts as pairwise reference images. Missing or ambiguous baseline images are configuration errors. Missing ordinary-agent candidate evidence or blocked scenarios are unavailable coverage; completed controlled captures missing a required candidate are contract errors. Candidate and baseline crops must have equal pixel dimensions; incompatible geometry is an execution error rather than a silently resized comparison.

All seven image-health metrics are measured from source pixels. Only configured metric bounds contribute checks. Each policy supports `change: relative` (default) or `absolute`, optional `mean` bounds, and optional `perScene` bounds. Bounds use `min`, `max`, or `equals`; at least one mean or per-scene bound is required across the rubric. Mark `gate: true` to block on failure or unavailability; without it the rubric still contributes ordinary points.

Absolute change is `candidate - baseline`. Relative change is `(candidate - baseline) / baseline`, so `-0.08` means an 8% drop. For fractions, an absolute increase of `0.05` means five percentage points. `minimumBaseline` defaults to `0.000001`: a baseline below it makes the relative change unavailable, even for zero-to-zero comparisons. AEK does not clamp denominators or fall back to an absolute comparison. Choose an explicit absolute policy when that is the meaningful assertion. `minimumBaseline` has no effect on absolute checks.

Means are unweighted means of per-scene changes over the entire selected rubric cohort, not ratios of mean image statistics. Reports show each scene, the expected and available sample counts, mean, minimum, maximum, and every bound. A missing required member or undefined relative change prevents its aggregate from being computed and makes the rubric unavailable. Known failures remain visible. Use per-scene bounds as well as mean bounds when an improvement elsewhere must not hide a local regression.

Higher entropy, contrast, or gradients do not universally mean better output: noise can increase them and cleaner rendering can decrease them. Thresholds need calibration against representative accepted and defective captures. Changing measurement regions, definitions, or baseline pixels changes the evaluation method and requires a fresh run.

The visual method revision is included in evaluator fingerprints. The independent temporal tolerance and observed-failure semantics in this revision require new runs rather than resuming a run from the earlier visual implementation.

## Browser diagnostics and managed servers

All browser sessions retain bounded console-error, page-error, failed-request and HTTP-error events. Configure checks and attach a `capture` grader to their browser scenarios:

```yaml
browser:
  diagnostics:
    failOn: [pageerror, requestfailed, http]
    ignoreUrls: [/expected-missing-resource]
```

`ignoreUrls` contains literal URL substrings. Events remain retained even when excluded from checks. Diagnostics do not record request/response bodies. Overflow is an execution error, avoiding an apparently complete result from a truncated event stream. Ordinary browser scenarios can use this grader without a controlled adapter. Mark the rubric `gate: true` to make failures release-blocking.

Recording creates an explicit stream and a start marker, even when no errors occur. If recording never started (for example, a mock collector that never starts a browser), missing diagnostics supply no checks and cannot pass a diagnostic rubric. Once recording started, a missing stream is an execution error. Every record is schema-validated before URL exclusions or checks: unknown event kinds, missing fields, invalid HTTP statuses, and malformed JSON abort with the file and line number. The 1,000-event limit is shared across every page in the browser session.

When `target.start` is configured, AEK probes the target endpoint before setup/start and rejects an existing listener. `target.allowExternalServer: true` explicitly allows reuse and skips the start command when the endpoint is occupied. With no start command, externally managed deployments continue to work normally. Use immutable production builds and strict server ports for canonical visual runs; an endpoint probe alone cannot attest to a deployment's source revision.

## Blind pairwise grading

For agent-driven browser scenarios, set `browser.screenshotFormat: png` to retain lossless visual evidence without requiring a project adapter. Controlled capture always uses PNG. Ordinary scenarios retain their current animation behavior.

```yaml
grader:
  type: pairwise
  candidate: frame-001
  policy: non_regression       # or preference
  references:
    - file: evals/references/approved.png
    - file: evals/references/alternative.webp
      crop: { x: 0.1, y: 0, width: 0.8, height: 1 }
      candidateCrop: { x: 0.1, y: 0, width: 0.8, height: 1 }
  panel: { width: 1280, height: 800, fit: contain, background: '#ffffff' }
  voting:
    minimumVotes: 5
    maximumVotes: 9
    agreement: 0.8
    minimumConfidence: 0.55
```

`candidate` is an exact screenshot label within each referenced scenario. Blocked scenarios and missing ordinary-agent screenshots are unavailable coverage. For controlled captures, the configured frame/pass counts determine valid labels; invalid labels fail validation before collection or reference loading, and a completed controlled capture missing a required screenshot is a contract error. `contact-sheet` is available only with multiple frames; first-pass labels have no pass prefix. These rules apply to all image graders. Ambiguous labels are always contract errors. References are explicit local files relative to `project.root`. Download and review remote assets first so their bytes are pinned. Files are limited to 25 MiB and decoded images to 40 million pixels. Supported image inputs are decoded by Sharp and normalized to PNG. Crops use normalized coordinates and must fit inside the source image.

Every candidate/reference pair is judged separately. Both sides are oriented, stripped of metadata, flattened, cropped, resized to equal dimensions, and encoded identically. Each fresh provider context receives only anonymous A/B panels and the criterion. A/B assignment is independently randomized and retained for audit. Claude/Grok must successfully view both panels before returning a non-abstaining result. Missing required views raise a judge-contract error, even at low confidence; that failed invocation is retained for diagnosis but is not recorded as a vote. An explicit abstention remains valid uncertainty. Malformed image-view transcripts are execution errors.

Source preparation uses a lossless PNG intermediate, including for JPEG references, so orientation/cropping does not introduce another lossy encoding before comparison.

The judge returns A, B, equivalent, or abstain, with confidence, reasoning, and optional localized findings. Low confidence becomes abstention, never equivalence. `preference` requires candidate wins; `non_regression` accepts candidate wins or observed equivalence. A decision needs `agreement × attempted votes`, rounded up, after `minimumVotes`. Abstentions stay in that denominator. Unresolved results at `maximumVotes` are inconclusive and map to `cannot_judge`. Provider/schema/tool-policy failures abort execution instead of becoming votes. Vote agreement and self-reported confidence are heuristics, not calibrated statistical confidence intervals.

Vote outcomes and terminal decisions are explicitly checked. Unknown states, nonterminal `continue` decisions reaching scoring, and decisions inconsistent with the voting policy are internal execution errors; they are never converted into a product failure or unavailable score.

Every reference and scenario must fully pass for the rubric to pass. Mixed judgeable outcomes receive partial credit; any unresolved comparison makes the aggregate unavailable. Case results feed the existing strata, campaign and comparison machinery. The HTML report links each pair's panels, pixel differences, votes and findings. Finding regions refer to the normalized candidate panel, including its configured crop.

## Reference images in baselines

```bash
aek baseline promote --run "$REVIEWED_RUN" --name visual --reviewer dean --include-images
```

`--include-images` explicitly copies screenshot pixels into the immutable baseline snapshot; those pixels may contain private application data. Ordinary promotion retains the existing compact report-only format. Every image is hashed and verified when loading the baseline. Select an image by scenario and label:

```yaml
references:
  - baseline: visual
    scenario: CHART           # defaults to the current materialized scenario ID
    label: frame-001
```

Missing images and ambiguous labels fail before collection. Each run snapshots the resolved reference bytes into `inputs/visual`; those hashes participate in evaluator compatibility and resume. A changed reference or baseline image therefore requires a new run. Snapshot images remain available if the external original is later removed. Public exports continue to exclude all image pixels, findings, reference paths and prompts.

## Repeated rubric judging

For ordinary LLM and hybrid automatic rubrics, configure:

```yaml
judge:
  provider: claude
  voting:
    minimumVotes: 3
    maximumVotes: 7
    agreement: 0.8
    minimumConfidence: 0.55
```

The collector runs once. Each vote uses a fresh judge context over the same sealed evidence, with an independent decision for each rubric and case. Existing confidence labels map to high=1, medium=0.7, low=0.3 for the configured cutoff. Missing/low-confidence judgements count as abstentions. Aggregate passes still require every applicable case to pass. Omitting `judge.voting` preserves single-judge behavior. Hybrid manual shares remain unchanged.

`judge.concurrency` (1–8, default 1) bounds concurrent pairwise rubric workers. Votes and references within each worker remain sequential. Failed workers stop queued work, and active workers drain before the run lock is released.

Completed votes are atomically journaled and integrity-sealed before proceeding. `aek run --resume` reuses both completed collection and completed votes after a later judge failure, and validates evidence bytes, inputs and provider method before reuse. A corrupt vote fails verification. Repeated judging isolates judge variability; campaigns still measure variability across complete collection/judging runs.

Completed vote journals and their sealed artifacts remain immutable even when the overall run failed; resume reports corruption before cleaning up unfinished work. If managed startup changes the target, sealed scenarios cannot be reused, including scenarios collected before the first area report was written. Reference snapshots are checked against the already-created receipt before collection starts.
