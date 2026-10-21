# Project authoring walkthrough

Run the entire offline walkthrough with one command after installing AEK:

```sh
node node_modules/agent-eval-kit/examples/authoring/run.mjs ./aek-authoring-demo
```

From a built source checkout, use `node examples/authoring/run.mjs ./aek-authoring-demo`.
The destination must be new. It retains working, broken and restored runs,
the regression comparison, a calibrated quantity requirement, and command logs
under `.agent-eval/walkthrough/`. The script restores the target on failure too.
Continue below to perform the same steps manually.

For an introduction to scores, coverage, gates, and revision comparisons, start
with [your first evaluation](../../docs/first-run.md), which also runs entirely
from the installed package. This walkthrough adds requirement mapping and
calibration records.

This synthetic project's requirements are: prices and totals use integer cents;
quantities multiply unit prices; an empty cart totals zero. The included map's
review identities describe this fixture, not a review of your product.

From a project with a local npm installation of AEK, copy the packaged example:

```sh
cp -R node_modules/agent-eval-kit/examples/authoring ./aek-authoring-demo
cd aek-authoring-demo
npx --no-install aek author init
cp plan.json .aek-authoring/plan.json
npx --no-install aek author validate --require-ready
npx --no-install aek run
```

From the AEK source checkout instead, copy `examples/authoring` to a temporary
directory and use `pnpm aek ... --config <copy>/evalkit.yaml` for runs and
`pnpm aek author ... --project <copy>` for authoring commands.

Both requirements start `configured`. Record the printed good run directory.
Change only `cart.mjs` in your disposable copy:

```js
export function total(lines) {
  return lines.reduce((sum, line) => sum + line.priceCents, 0);
}
```

Run again. The new run should exit 2: QUANTITY fails (500 rather than 1000 cents)
while EMPTY passes. Restore the original `cart.mjs` after the experiment.

In `.aek-authoring/plan.json`, add the two paths to each requirement's `trials`:

```json
[
  {"kind": "good", "run": ".agent-eval/runs/GOOD-ID", "rationale": "Original quantity-aware target."},
  {"kind": "defect", "run": ".agent-eval/runs/DEFECT-ID", "rationale": "Target deliberately ignores quantity; checker unchanged."}
]
```

Replace GOOD-ID and DEFECT-ID with the actual directory names, then run:

```sh
npx --no-install aek author status --json
```

QUANTITY is `calibrated`; EMPTY is `exercised`, because this defect did not violate
the empty-cart requirement. To calibrate EMPTY too, retain the good run, make a
separate target defect that returns a nonzero value for an empty list, run it, and
record that defect trial. Restore the target afterward.

An empty map or unresolved decisions remain incomplete. Missing trial files,
invalid check IDs, tampered evidence, and changed checker definitions are errors.
Editing the authoring map does not change target or evaluator fingerprints.
This walkthrough calls no model and does not test the interviewing skill's quality.

To reuse ordinary Node.js tests instead of the direct checker, follow the
[worked JSON adapter](../../docs/existing-tests.md). The included `cart.test.mjs`
and `test-adapter.mjs` are used only by that optional example.
