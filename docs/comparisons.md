# Compare runs, baselines, and campaigns

Use comparisons to check a revision against a reviewed result, promoted baselines
to record accepted results, and campaigns to measure stability across repeated
runs. See the [command guide](cli.md#compare-promote-and-share) for a command
summary and [exit statuses](cli.md#exit-statuses).

## Compare runs

Compare two run directories—or two explicit `report.json` files whose parent directories are sealed runs—without another agent call:

```bash
aek compare \
  --baseline .agent-eval/runs/2026-09-01T12-00-00 \
  --candidate .agent-eval/runs/2026-09-04T12-00-00
```

This writes `comparison.json` and a standalone `comparison.html` below the candidate run's `comparisons/vs-<baseline-run-id>/` directory. The report includes overall, area, tag, and rubric-item deltas; item changes distinguish improvements, regressions, gained/lost coverage, additions, and removals.

The HTML report also shows baseline/candidate reasoning, confidence, critical
gates, evidence links, and relevant screenshot/text previews. Filter the review
to regressions, lost coverage, or critical gates; unchanged decisions remain
inspectable. Evidence links are relative to the output location and require the
retained source artifacts. Promoted snapshots omit private reasoning and evidence,
so previews are available only for retained artifacts.
Human adjudications show the reviewer rationale and provenance alongside the
original automatic explanation.

Rubric items retain weighted score and coverage measurements, so hybrid regressions are detected even when both aggregate verdicts are `partial`. Campaign case coverage is judgeable repetitions divided by all attempted repetitions, including failed runs; pending runs are excluded. `--fail-on-regression` detects partial case coverage loss and decreases in campaign mean evidence coverage. See [release validation](release-validation.md#comparison-and-recovery-corrections-013) for artifact regeneration and interrupted-lock recovery.

Comparisons require current, receipt-bearing reports and a valid `artifact-index.json` for both direct inputs. They verify that both have the same evaluator fingerprint: kit version, provider versions/configuration, scoring method, variables/instructions, selected inputs, exact specs, and exact fixtures. Incompatible reports still produce an audit report, but numeric deltas are withheld and the command exits with status `2`. Use `--allow-incompatible` only for exploratory analysis; it records the override and enables deltas explicitly.

### Comparison gates

Optional comparison gates also exit with status `2` after writing the report:

```bash
aek compare --baseline "$BASE_RUN" --candidate "$CANDIDATE_RUN" \
  --fail-on-regression --max-score-drop 2 --max-coverage-drop 5
```

`--max-score-drop` and `--max-coverage-drop` are in percentage points.
`--fail-on-regression` treats a lower item verdict, lost item coverage, a removed item, or a removed area as a regression. Score-drop enforcement fails closed when either headline score was withheld, because the two scores are not safely comparable.

## Promote baselines

Promote a reviewed run to a named baseline, then compare against that name:

```bash
aek baseline promote --run "$BASE_RUN" --name main --reviewer dean
aek baseline list
aek compare --baseline-name main --candidate "$CANDIDATE_RUN" --fail-on-regression
```

Release promotion (the default) also checks the full declared scenario suite, required gates, and promotion coverage/score policy. The default requires 100% coverage across all splits in required areas. Use an explicitly reviewed `--mode milestone --reason "..."` for an intermediate result; the exception is recorded. See [promotion policy](evidence-workflows.md#baseline-promotion-policy).

Promotion requires a valid `run-state.json` with `status: complete`, then verifies the source artifact index. Every promotion creates a new content-checked snapshot containing the comparison-relevant report fields, source report and artifact-index hashes, evaluator fingerprint, target revision, reviewer, and timestamp. Full scenario evidence and judge reasoning remain in the source run rather than being copied into the baseline. Updating a name moves only its atomic `current.json` pointer; previous snapshots remain available in the baseline directory. The default `evals/baselines` location is evaluator-hidden and suitable for code review and version control.

For screenshot pixels in baselines, see
[reference images in baselines](visual-evaluation.md#reference-images-in-baselines).
Promoting a text reference is a separate workflow; see
[promoted text references](text-evaluation.md#promoted-text-references).

## Repeated-run campaigns

Coding-agent results are stochastic, so AEK can execute the same resolved evaluation sequentially several times:

```bash
aek campaign --repetitions 5
aek campaign --repetitions 5 --areas checkout --output .agent-eval/campaigns/checkout
```

Resume an interrupted campaign with `aek campaign --resume <campaign-directory>`.
Recovery restores the original options and thresholds, verifies retained artifacts,
and continues only repetitions that never started. Failed or interrupted attempts
remain in the results. See [campaign recovery](cli.md#campaign-recovery).

Each repetition remains a normal independently receipted run. `campaign.json` and `campaign.html` report completion failures, score and coverage mean/median/range/standard deviation, deterministic 95% percentile-bootstrap intervals using the complete run as the resampling unit, critical-gate pass rate, and rubric, case, and stratum verdict stability. Aggregate metrics are withheld if evaluator or strict target-input fingerprints differ. Campaigns are deliberately sequential to avoid subscription concurrency and rate-limit surprises. Intervals are descriptive and small repetition counts remain unstable. A campaign does not reset a deployed target's database: use idempotent scenarios, isolated test tenants, or a lifecycle setup command that restores state between runs. See [preparing state for repeated runs](evidence-workflows.md#preparing-state-for-repeated-runs).

An incompatible campaign exits with status `2` even if every individual repetition passes its numeric thresholds; execution failures take precedence with status `1`. Hybrid rubric stability counts a full pass only after every required automatic and manual share passes. Pending hybrid reviews retain automatic credit and `components.automatic`, while their aggregate verdict is `cannot_judge` until review is complete. Case and stratum diagnostics continue to describe automatic judgements.

### Compare campaigns

Compare two campaigns over matching stable cases:

```bash
aek campaign compare \
  --baseline .agent-eval/campaigns/before \
  --candidate .agent-eval/campaigns/after \
  --fail-on-regression
```

The comparison reports each case's mean verdict value across repetitions, improvement/regression and coverage/add/remove states, stratum-level mean deltas, and a deterministic 95% paired-case bootstrap interval. The resampling unit is the matched case, so large matrices do not get confused with random repetition noise. Numeric results are withheld when evaluator fingerprints differ unless `--allow-incompatible` is explicitly recorded. `--fail-on-regression` exits with status `2` after writing the JSON and HTML reports if a case regresses, loses coverage, or disappears, or if the campaign mean score, critical-gate pass rate, or completion rate falls. Completion rate is completed runs divided by attempted runs; pending repetitions are excluded. It is checked even for campaigns without case results. Execution failures remain separate from product scores and evidence coverage.

## Benchmark experiments

For project-owned benchmarks that compare multiple candidates with controlled
visit order and a shared resource, use `aek benchmark experiment`. See
[controlled benchmark experiments](cli.md#controlled-benchmark-experiments) for
the command contract and the [benchmark guide](../examples/benchmark/README.md)
for the recipe, correctness gates and limits of the descriptive comparisons.
