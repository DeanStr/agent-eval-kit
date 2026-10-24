# Author evaluations for a whole project

The `aek-author` skill helps your coding agent survey a project, interview you
about expected behavior, and write a runnable AEK suite. You can also use it to
add one feature or continue an existing project map. The agent conducts the
conversation; `aek author` supplies deterministic installation, map validation,
rubric-link checks, and verification of recorded trials.

## Install and start

From a project with AEK installed:

```sh
npx aek skills install
```

This installs `aek-author`, with its instructions, references, and a copy of the
package documentation, together with the [`aek-improve`](improvement.md) skill.
It uses `.claude/skills/` when the project has a `.claude/` directory and no
`.agents/` directory, and `.agents/skills/` otherwise; `--agent claude|codex|cursor|grok`
or `--directory` chooses explicitly. To install only the authoring skill, use
`npx aek author install [--directory .claude/skills]`.

Installation refuses to overwrite an existing skill. To update, install into a
separate directory, review the differences, and replace your old copy when ready.
Load/reload skills as required by your coding agent. If it does not discover the
skill automatically, tell it to read `.agents/skills/aek-author/SKILL.md`.
Use `pnpm exec aek` with a pnpm consumer, `pnpm aek` from this source checkout,
or `aek` when globally linked wherever these examples show `npx aek`.

In your coding agent, ask:

> Use $aek-author to look through this whole project and build an evaluation suite.
> Ask me about product expectations you can't establish from our requirements.

Or:

> Use $aek-author to add cancellation evaluations to our existing suite.

The skill doesn't invoke another subscription itself. Your current coding-agent
session performs discovery and authoring. Subsequent evaluation runs use the
providers selected in the generated config. Model pilots and external actions
need the appropriate execution authorization; validation and dry runs use no
model quota. You don't need an eval config to begin the interview.

## What the user sees

The agent first reads project documentation, interfaces/routes, existing tests,
and evals, then proposes a map of actors, jobs, outputs, and integrations. You
correct omissions, settle priorities, and confirm the intended scope. A discovered
implementation behavior remains an inference until its intended contract is clear.

Questions begin with shared choices such as test environment, roles, and reset,
then move into particular areas. They arrive in small related rounds, with
follow-ups based on your answers. Questions the repo can answer are investigated
by the agent. Product decisions stay with you; “unknown” stays unresolved.

For each requirement, you review the exercise, expected result, and evidence.
The agent writes the YAML and helpers, choosing browser, command, workspace,
text, image, or integration checks as appropriate. It reuses existing tests when
their assertions establish the requirement, adding checks only for missing behavior.
Tests are connected explicitly through command graders. A small result adapter may
be needed to distinguish assertion failures from runner errors without duplicating
the tests; see [command grader contracts](graders.md#command) and the
[worked test adapter](existing-tests.md).

It validates each area as it goes, preserves existing checks, and records remaining
work for later sessions. An executable suite can grow while other areas still have
unresolved questions.

Finally, the agent runs authorized pilots and reviews failed rubric items, gates,
coverage, and representative passes against their evidence. Surprising results
can reveal evaluator mistakes or missing expectations to resolve before revising
the criteria. For important checks, calibration includes a meaningful defect and
a valid variation the evaluator should accept, within the authorized budget.
The agent reports configuration validity, execution, product outcomes, and
calibration separately.

## Maintain an existing suite

Ask your agent:

> Use $aek-author to review this suite since its last maintenance review. Inspect
> current interfaces for unmapped workflows, preserve agreed expectations, and
> carry unfinished work forward.

The agent reads the map, status, prior review, and outstanding work. It reviews
commits since the recorded revision, staged/unstaged changes and untracked files,
then surveys today's interfaces, docs, and tests for omissions even outside that
diff. With no previous review it establishes an initial baseline and states what
history is unknown. Requirement IDs and agreed expectations persist; an intended
behavior change needs an authoritative product decision, not just changed code.

Reviews live in `.aek-authoring/reviews/`, using the shipped
[review-note template](../skills/aek-author/templates/review-note.md). They record
reviewed revision, scope, working changes and their content evidence, sources,
findings, runs, and outstanding work. The existing `plan.json` remains the only
feature map. Notes distinguish new coverage gaps, intended behavior changes,
collection problems, evaluator mistakes, product regressions, unresolved intent,
and unavailable evidence. A broken collector remains an execution error; a valid
blocked observation reduces coverage. Neither becomes a fabricated product score.

The agent exercises affected checks and ordinary tests. Changed evaluators need
fresh good/defect calibration with a fixed method and important valid variations.
Superseded trials, rationale, method identity, and original run paths stay under
`.aek-authoring/history/`; sealed runs remain intact. Unfinished work carries into
the next review. See the [maintenance workflow](../skills/aek-author/references/maintenance.md).

Review freshness describes the scope and exact state actually inspected.
Historical calibration describes earlier examples against an evaluator. A map can
report `calibrated` while new workflows remain unreviewed; `ready` does not assert
freshness. This workflow adds no map fields or CLI commands.

## Saved project map and commands

The editable map lives in `.aek-authoring/plan.json`. This directory is reserved
for evaluator authoring: workspace scenario agents cannot read it, and changes
there are excluded from target fingerprints. It is not added to `.gitignore`;
you may review and commit non-secret maps to share decisions across sessions.
Keep credentials out and review private product context before sharing.

```sh
npx aek author init --description 'Evaluate the storefront release workflows'
npx aek author status --json
npx aek author validate --require-ready
```

Use `--project <directory>` to operate on another root and `--mode feature` with
`init` for a narrower task. Initialization never overwrites an existing plan.
`status` and `validate` perform the same structural and linked-evidence checks;
`--json` returns a version-1 summary for agents, otherwise output is readable text.
The skill edits the canonical JSON; there is no separate generated map to drift.

| Command result | Meaning |
| --- | --- |
| Exit 0 | The map and any referenced inputs/runs are valid; inspect `ready` for completeness. |
| Exit 1 | Invalid map, missing input, unknown rubric, incompatible method, or corrupt/invalid trial. |
| Exit 2 with `--require-ready` | Valid map with remaining authoring work. |

`ready` means the reviewed inventory has completed discovery, resolved decisions,
and active checks for all included requirements and prerequisites. Empty maps,
unreviewed scope, empty areas, and all-excluded maps are not ready. It means ready
to pilot; it does not require that the product passes or calibration is complete.

The summary reports per-requirement stages, blockers, open questions ready to ask,
remaining discovery, areas without requirements, and unmapped rubrics. Preserve
unmapped existing checks while reviewing their relationship to the inventory.
Only suites referenced by checks are inspected; the agent must survey and record
all intended suites during discovery.

| Stage | What has been established |
| --- | --- |
| discovered | A sourced candidate requirement exists. |
| clarified | Acceptance, evidence, preparation, priority, and confirmation are recorded, with its decisions resolved. |
| configured | All linked rubric IDs exist and their evaluation inputs validate. |
| exercised | Every linked check has a fully observed decisive result in a verified completed run. |
| calibrated | Each linked check passed a known-good run and failed a compatible run with a different target identity. |
| excluded | A reviewer explicitly excluded it with a reason. |

An `exercised` check can have found a product failure. Valid abstentions and partial
coverage do not establish full exercise. Defect trials can establish calibration
with `fail` or `not_found`: confirmed absence is an observed product failure.
Both still require full coverage, a passing good trial, matching evaluator
fingerprints, and different target identities. Calibration describes the recorded pairs;
it does not establish every case or estimate judge accuracy. AEK verifies artifacts
and method/target identities; the human supplies the rationale that an intentional
defect is relevant. Maps and review identities are editable records, not signed
approvals. Remote target changes without a distinguishable receipt identity cannot
establish a verified calibration pair.

Trial checking recomputes the current evaluator fingerprint without model calls.
Keep the provider/model settings used by pilots in config. It can require installed
provider CLIs/browser tooling to read their versions, as well as original evaluator
inputs. Changes to specs, checker methods, references, fixtures, or runtime/provider
versions can invalidate active trials. Keep superseded references in authoring
history and rerun both targets using the revised method.

For the complete JSON field contract and example see the shipped
[map reference](../skills/aek-author/references/plan.md); for authoring decisions
see [generation and calibration](../skills/aek-author/references/generation.md).

## Project scope is different from evidence coverage

A run can have 100% evidence coverage over three rubrics while omitting half the
product's important jobs. The map exposes what you discovered, agreed to cover,
excluded, or have not yet configured. It never turns that inventory into a claim
of exhaustive product coverage or merges it into the run's quality score.

## Offline walkthrough

Run the packaged authoring walkthrough in a new directory:

```sh
node node_modules/agent-eval-kit/examples/authoring/run.mjs ./aek-authoring-demo
```

It installs the authoring skill, loads the fixture's documented requirement map,
runs a working calculation, detects a deliberate quantity defect, saves the
comparison, restores the target and records verified trials. `QUANTITY` becomes
calibrated; `EMPTY` remains exercised because the seeded defect does not violate
that requirement. The summary retains command exit codes and elapsed times.
This is a scripted fixture, not a measurement of the agent's interviewing skill.

The [authoring example](../examples/authoring/README.md) is included in the package.
It demonstrates a project map, configured checks, and a good/defect calibration
without a provider login or browser. It exercises CLI contracts rather than
measuring how well an agent conducts an interview. Real authoring still requires
reviewing that the generated criteria preserve the user's intent.

For an optional live exercise from the source checkout, see
[the marketing improvement exercise and results](history/marketing-improvement-exercise-2026-09-10.md).
Its runnable files are in `examples/improvement-exercise/`; they require Playwright
Chromium and a Codex subscription and are not included in the package or run by
the default test command. The exercise checks valid wording, seeded regressions,
and incremental repairs with a fixed evaluator.
