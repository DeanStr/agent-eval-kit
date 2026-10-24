# Specs, cases, and fixtures

Scenario and rubric definitions live in the files selected by `paths.specs` in
`evalkit.yaml`; see the [configuration reference](configuration.md). This guide
covers area specs, case matrices, critical gates, and fixture uploads. See
[grader types](graders.md) for the `grader` field and
[evaluation types](evaluation-types.md) for choosing an evidence source.

## Area specs

Every YAML file under `paths.specs` is one weighted area. Required area weights must total exactly 100; optional areas are excluded from the headline score.

```yaml
id: checkout
title: Checkout
weight: 35
description: A buyer can complete a safe, persistent checkout.

scenarios:
  - id: CART-S1
    name: Add, update, and persist a cart
    kind: browser              # browser | workspace; defaults from target.kind
    persona: buyer
    dependsOn: []
    requiresAuth: false
    instructions: |
      1. Add the fixture product to the cart.
      2. Change quantity to two and reload.
      3. Capture the persisted total.
    successSignals:
      - Quantity and total remain correct after reload

rubric:
  - id: CART-01
    criterion: Cart quantity and total persist across reload
    weight: 3
    gate: true                    # optional: this item must fully pass
    tags: [crud, persistence, money]
    scenarios: [CART-S1]
    grader: { type: llm }
    passCriteria: Quantity is two after reload and total equals two unit prices.
    evidence: Before/after screenshots with product, quantity, and total.
```

IDs are globally unique and must remain distinct under case folding so the same kit is safe on case-insensitive filesystems. Scenario IDs also cannot use names reserved by the top-level run artifact layout, such as `inputs`, `areas`, or `report.json`. Rubric `scenarios` must refer to scenarios in the same area. Scenario dependencies gate dependent execution across the selected suite; prerequisites execute first, with file order breaking ties. Browser scenarios in the same dependency chain share isolated temporary storage state. An existing captured persona state takes precedence; merely naming an uncaptured persona never creates trusted authentication state, and its chain remains run-local.

For suite-wide dependencies, typed output/input bindings, and isolated saved-persona switching, see [scenario workflows and personas](workflows.md). For captured sessions, see [authentication](authentication.md).

## Case matrices, strata, and splits

Use `cases` to execute one scenario against controlled variations without copying its instructions:

```yaml
scenarios:
  - id: CANCEL-S1
    name: Cancel a subscription
    kind: browser
    instructions: Cancel the subscription described by the case variables and verify the final state.
    cases:
      - id: monthly-active
        split: development
        variables: { plan: monthly, accountState: active }
        strata: { plan: monthly, account_state: active }
      - id: annual-past-due
        split: evaluation
        variables: { plan: annual, accountState: past_due }
        strata: [plan=annual, account_state=past_due]
```

Case variables override same-named project variables for that execution. Object strata normalize to stable `dimension=value` labels; the list form is accepted when labels are already normalized. Reports show automatic score and coverage slices for each stratum and retain the case ID and split, but never copy case variables into the public-export format.

Run a split with `aek run --split development` or `aek run --split evaluation`. The CLI defaults to `development`, protecting reserved evaluation cases from routine tuning; `--split all` is an explicit diagnostic option. Scenarios or cases without an explicit split are shared and run in either selection, so existing suites remain compatible. An LLM or hybrid rubric referencing a matrix scenario is evaluated across the selected cases, with a separate automatic diagnostic verdict for every stable rubric/case pair. Its aggregate full `pass` requires every applicable case to pass. A proposed full pass with any unavailable case becomes `cannot_judge`; mixed fully observed outcomes become `partial`. Command and manual-only rubrics remain rubric-level checks.

If a split leaves an area with no applicable rubric items, that area is omitted from the execution and receipt rather than reported as zero coverage. A selection with no applicable rubric items fails before a run directory is created or a provider starts.

When dependent scenarios both use a matrix, reuse the same case IDs, strata, and split in each scenario; their per-step variables may differ. AEK maps `VERIFY--annual` to `CREATE--annual` and validates missing or inconsistent dependency cases before a provider starts. The chosen split is recorded in the run receipt; changing the split or any spec bytes changes the evaluator fingerprint, so evaluation baselines fail closed rather than silently drifting.

A direct text rubric can bind to a dataset for case results, strata, and splits
independently of collection scenarios; see
[text datasets](text-evaluation.md#datasets-grouped-cases-and-reusable-templates).

## Critical gates

Set `gate: true` only on genuinely release-blocking criteria. A critical item must receive a full `pass`; `partial`, `fail`, and `not_found` fail the run, while missing/manual/blocked evidence makes the gate unavailable and also fails closed. Critical gates apply independently of weighted aggregate score and are enforced even when no `--fail-under-*` flags are supplied. See [CI thresholds](runs.md#ci-thresholds) for numeric acceptance flags.

## Fixtures and uploads

Arbitrary fixture data is passed to scenarios. Browser agents may upload only named paths in the top-level `files` map, preventing them from choosing files elsewhere on disk.

```yaml
data:
  product: Test Widget
  uniqueEmail: aek-buyer@example.test
files:
  avatar: ./files/avatar.png
  importCsv: ./files/import.csv
```

`aek validate` resolves these paths relative to the fixture document and verifies that every entry exists and is a regular file. Missing uploads therefore fail before any provider is started or subscription quota is used.

For downloaded files, general command evidence, scenario checkpoints, and declared
applicability, see [file evidence and evaluation scope](file-evidence.md).
