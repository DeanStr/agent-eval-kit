# Your first evaluation

Run a tiny cart evaluation, read its report, then introduce a defect and compare the two runs. This walkthrough uses deterministic command graders and an offline mock collector: it needs Linux, Node.js 20.19+, and pnpm, but no provider login or browser installation. It demonstrates the harness; it does not measure an LLM judge's accuracy.

## Run the working example

From the repository root:

```bash
pnpm install --frozen-lockfile
demo=$(mktemp -d)
cp -R examples/first-run/. "$demo/"
pnpm aek validate --config "$demo/evalkit.yaml"
pnpm aek run --config "$demo/evalkit.yaml"
```

The copy gives you a disposable project to edit. Keep this terminal open so `$demo` remains set. The run prints the full path to `report.html`; open that file in your browser. Its sibling `report.json` contains the machine-readable results.

The example's four relevant files are:

| File | Purpose |
| --- | --- |
| `evalkit.yaml` | Selects the project, offline providers, and coverage threshold. |
| `specs/cart.yaml` | Defines two automatic checks and one human review. |
| `cart.mjs` | The target implementation. |
| `check.mjs` | Executes the target and emits a structured pass or fail with observed values. |

The mock scenario contributes no measured claims. Both automatic checks execute real code; the manual review is deliberately left pending.

## Read the report

You should see **100% score, 80% coverage, and a passed critical gate**. The command exits 0.

| Report entry | Result | Meaning |
| --- | --- | --- |
| `QUANTITY`, weight 3, critical gate | Pass | Two 500-cent items totaled 1000 cents. |
| `EMPTY`, weight 1 | Pass | An empty cart totaled zero. |
| `RECEIPT`, weight 1 | Pending manual review | No human verdict has been supplied. It contributes no score or coverage. |
| Overall score | 100% | All 4 units of judgeable weight passed: 4 / 4. |
| Overall coverage | 80% | 4 of the 5 units of rubric weight were judged. |
| Score withheld | No | Coverage exceeds the configured 60% minimum. |
| Critical gates | Passed | `QUANTITY` received a full pass. |

The pending review is also listed in `manual-checklist.md`. Follow the report's evidence references to `areas/cart/graders/QUANTITY.stdout.txt` to see the observed and expected totals.

Score describes performance on the evidence available; coverage describes how much of the rubric that evidence supports. A 100% score at 80% coverage does not establish that every criterion passed. Critical gates enforce designated requirements independently of the weighted score. The configured minimum coverage controls whether the headline score is withheld; CLI thresholds add explicit exit-status checks.

This abbreviated `report.json` excerpt corresponds to the working example:

```json
{
  "overallScorePct": 100,
  "overallCoveragePct": 80,
  "scoreWithheld": false,
  "manualPending": 1,
  "gates": { "passed": true, "blocking": [] }
}
```

Record the directory containing that report. Replace the placeholder with the run ID printed by the command:

```bash
baseline="$demo/.agent-eval/runs/<first-run-id>"
```

## Introduce a regression

Replace only the target implementation, leaving the rubric and checker unchanged:

```bash
cat > "$demo/cart.mjs" <<'JS'
export function total(lines) {
  return lines.reduce((sum, line) => sum + line.priceCents, 0);
}
JS
pnpm aek run --config "$demo/evalkit.yaml"
```

This implementation ignores quantity. The new report should show:

| Measurement | Working run | Broken run |
| --- | --- | --- |
| `QUANTITY` | Pass: 1000 cents | Fail: 500 cents |
| `EMPTY` | Pass | Pass |
| Overall score | 100% | 25%: 1 / 4 judgeable weight passed |
| Coverage | 80% | 80%: both automatic checks still ran |
| Critical gate | Passed | Failed |
| CLI exit status | 0 | 2 |

Exit 2 is expected here: the harness collected evidence and found a critical product defect. It writes the reports before exiting. Execution errors, such as invalid grader JSON, use exit 1 instead.

Record the second run ID and compare:

```bash
candidate="$demo/.agent-eval/runs/<second-run-id>"
pnpm aek compare --baseline "$baseline" --candidate "$candidate" --fail-on-regression
```

The comparison also exits 2. Open the printed `comparison.html`: `QUANTITY` regressed, the score dropped 75 percentage points, and coverage stayed unchanged. The evaluator fingerprints remain compatible because you changed the target implementation rather than the evaluation definition. Start a new run when changing the target; resume is for continuing the same inputs.

## Evaluate your project next

Use [onboarding your project](onboarding.md) to choose a target-specific starter and repeat this good-versus-broken calibration with a requirement from your own project. The generated `evals/ONBOARDING.md` includes preparation steps and a completion checklist. Replace command graders with checks relevant to your project, choose real providers for LLM-graded scenarios, and retain manual review only where a person must supply evidence. See [grader types](../README.md#grader-types), [CI thresholds](../README.md#ci-thresholds), and [manual finalization](../README.md#run-resume-rescore-finalize) for the next steps.
