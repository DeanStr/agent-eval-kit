---
name: aek-author
description: Discover a project's user jobs and requirements, interview the user about missing expectations, and create or extend a runnable Agent Eval Kit evaluation suite with saved decisions and calibration. Use for whole-project evaluation setup, converting stories into evals, or continuing an existing authoring map.
---

# Author project evaluations

Deliver a reviewed inventory of product requirements, an executable AEK suite, and
an honest account of what is unconfigured, unexercised, or uncalibrated. Support
whole projects by default; narrow to the feature or update the user requested.
This is evaluation authoring, not permission to redesign the target product.

## Start and continue

Find the AEK CLI before generating commands. Use `npx --no-install aek` for a local
npm install, `pnpm exec aek` for a local pnpm install, `pnpm aek` from the AEK source
checkout, or an available global `aek`. Check its `--help`. If unavailable, explain
that the AEK package must be installed; do not silently fetch a similarly named CLI.

Read `.aek-authoring/plan.json` first if present, along with the existing config,
specs, and project instructions. Run `aek author status --project <root> --json`.
Continue recorded decisions; do not initialize over the map or discard existing
rubrics. For a new map use `aek author init --project <root>`; use `--mode feature`
for a bounded feature request. No eval config is needed to start discovery.
Read [the map contract](references/plan.md) before writing the map. Write changes
atomically, re-read before updating, and preserve other contributors' edits.

## Discover the whole scope

Inspect README/product docs, interfaces and routes, commands, existing tests,
fixtures, and evaluation files. Describe actors, important jobs, outputs,
integrations, failure paths, and cross-area dependencies. Record sources as
`document`, `user`, or `inference`; code shows what exists, not what should be
accepted. Propose inferred requirements as questions, never as approved behavior.
Record unexplored areas in `discovery.remaining`. An inventory is bounded by what
was inspected and what the user agreed; do not claim exhaustive product coverage.

Show a compact project map: area, proposed jobs/checks, importance, unknowns, and
setup needs. Ask the user to correct omissions, identify critical behavior, and
confirm scope. Save the review identity only when the user actually confirms it.
For a large project keep one project map and work area by area across sessions.
Do not require an issue tracker or ask the user to enumerate every story themselves.

## Interview for decisions

Investigate discoverable facts yourself. Ask the user about product intent,
priority, expected values, scope, and tradeoffs that available authoritative
requirements do not settle. Start with shared decisions (roles, environment,
reset, release priorities), then move to area-specific behavior.

Ask a small, readable round of independent questions, each with why it affects
an evaluation and a proposed answer when useful. Use the host's user-input tool
when available. Defer dependent questions until their prerequisites are resolved.
Record every evaluation-relevant answer with its source, including numbers,
negative requirements, excluded behavior, and unresolved questions. A suggestion
is not a decision. Accept “unknown” and save it as open. Continue independent work
while answers are pending; never assume silence approves a product expectation.

For each included requirement settle: actor/action, starting state, observable
acceptance, evidence, preparation/reset, priority, and dependencies. Use a precise
statement or Given/When/Then if useful; don't enforce a story formula on source
contracts or exact command checks. Preserve the user's vocabulary.

## Generate a suite

Read [generation and calibration](references/generation.md) when converting agreed
requirements. Show the user a plain-language requirement → exercise → expected
result → evidence outline. Ask only about unresolved choices; existing clear
requirements do not need repeated approval. Record who confirmed each acceptance
contract. Explain proposed weights and gates and settle release-blocking choices.

Create or extend config, specs, fixtures, and necessary checkers/collectors. Link
each requirement to exact suite/area/rubric IDs in the map. Keep unresolved drafts
in `.aek-authoring`, outside executable specs. Preserve and report existing checks
that aren't yet mapped. Don't replace a whole project's checks with one starter.

Use the existing evaluation types as needed: browser stories, workspace source
contracts, deterministic commands, direct text, images, files, and integrations.
Prefer exact independent checks for calculations and structured outputs; model
judges interpret collected evidence. Never derive expected results by calling the
same implementation being evaluated. Runtime claims need exercised runtime evidence.

Keep authoring notes and decision records under `.aek-authoring`, which AEK hides
from workspace collection and excludes from target fingerprints. They may contain
private product context; don't place credentials there or copy answers into public
exports. Evaluation definitions belong in the configured specs/fixtures/method
files so they receive normal evaluator provenance.

## Validate, exercise, calibrate

Run `aek validate`, selected `aek run --dry-run` plans, and
`aek author validate --json`. A structurally valid map can still be incomplete;
`--require-ready` explicitly checks readiness to pilot the reviewed inventory.
Validate after each area; shared required weights must sum to 100. Keep the
project map when the work spans sessions, with the next unblocked questions.

Exercise pilots within existing execution authorization and available tooling.
Authoring alone does not authorize paid provider calls, destructive data resets,
live transactions, or changes to a production target. Prepare all safe setup and
make the specific remaining action reviewable before requesting needed permission.
Continue other authoring work when a prerequisite prevents one area's pilot.

Calibrate against a known-good target and deliberate defects in a disposable copy.
Keep evaluator definitions, checker logic, fixtures, providers, and selected cases
fixed across a pair. Read the evidence: exit 1 or missing coverage isn't defect
detection. Record good/defect run directories and rationale in the map; let
`aek author status` compute exercised/calibrated stages from verified runs. For
changed methods retain prior trial records in authoring history and replace active
trial references after rerunning. Never edit sealed run evidence to make a claim fit.

Finish with the generated file paths, validated commands, decisions still needed,
setup blockers, map status, actual pilot/calibration results, and the next action.
Separate project inventory progress from rubric evidence coverage and product
score. A calibration pair demonstrates that example, not statistical judge accuracy.
