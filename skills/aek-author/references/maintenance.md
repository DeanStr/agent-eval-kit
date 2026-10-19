# Maintain an evaluation suite

Use this workflow when asked to review or update an existing suite after changes.
It uses the existing `plan.json`, commands, and run receipts. Review notes are
prose records, not another feature map or new readiness/calibration fields.

## Establish the review boundary

1. Read project instructions, `.aek-authoring/plan.json`, config/specs, the latest
   review note, outstanding decisions, and superseded-trial history. Run
   `aek author status --project <root> --json` and retain output or diagnostics.
   Invalid trial references or methods are errors to investigate, not permission
   to delete history or claim the suite is current.
2. Start `.aek-authoring/reviews/<unique-review-id>.md` from
   [the template](../templates/review-note.md). Record reviewer identity honestly
   (agent assessment versus product-owner decision), time, scope, current revision,
   and the previous review path/revision. With no previous note, label this an
   **initial baseline**, survey the current scope, and record historical unknowns.
   Existing calibration runs alone do not establish a previous scope review.
3. Inspect revision changes: `git log --oneline <previous>..HEAD`,
   `git diff --name-status <previous> HEAD`, and the relevant full diffs. Inspect
   staged and unstaged changes (`git diff --cached`, `git diff`) and untracked
   files (`git ls-files --others --exclude-standard`). Retain `git status --short`,
   patches, and content hashes/copies of relevant untracked inputs under the
   review's evidence directory. A HEAD hash alone does not identify a dirty target.
   If the previous review included working changes, reconcile its retained
   patches/hashes with the current state too; a commit range alone cannot show
   everything that changed since that review.
   Exclude secrets and generated runs; describe redactions and resulting limits.
   If revision/history is unavailable or rewritten, say so and establish a scoped
   baseline using available content identities; never silently diff another ref.
4. Carry each unfinished item forward with its original note/requirement/decision
   reference, current state, and next action. Close it only with evidence. Record
   areas not inspected and limits of this session; a new date does not clear them.

## Survey and reconcile

Inspect both the change set and the **current** public interfaces: routes/screens,
commands/options, exported APIs, integrations, roles, failure/recovery paths,
docs, tests, and configured suites. Unchanged interfaces can expose old omissions.
Compare observed workflows to map requirements and existing unmapped rubrics;
record what was actually surveyed and the source for each proposed addition.
Do not claim exhaustive coverage from a diff or a passing run.

Preserve IDs and previously agreed acceptance, priorities, gates, and exclusions.
Append requirements and decisions to the canonical map. Code and current outputs
are observations, not authority to change expectations. For an intended behavior
change, retain the old expectation, the authoritative decision/source, the new
expectation, and affected IDs in the review. Update the existing requirement when
its job persists; introduce a new ID only for a distinct requirement. If scope
materially expands, follow the map contract for renewed scope review; don't invent
approval. Unknown intent stays an open decision while independent work continues.

| Classification | Evidence and action |
| --- | --- |
| New coverage gap | A sourced workflow lacks a mapped requirement/check, including old omissions. Add or clarify coverage; a gap itself is not a product failure. |
| Intended behavior change | An authoritative product decision changes the contract. Cite it, retain the prior expectation, and update affected checks. |
| Collection problem | Broken selector, command, extraction, reset, or adapter prevents a valid observation. Retain execution diagnostics, repair the procedure, and recollect. |
| Evaluator mistake | Valid evidence was judged incorrectly against the agreed contract. Correct checker/rubric/judge instructions, document the disagreement, and recalibrate. |
| Product regression | Valid evidence violates an existing agreed requirement. Preserve that requirement and the failing evidence; track the product fix separately. |
| Unresolved intent | Authority does not settle expected behavior. Record an open map decision; don't train the expectation on current output. |
| Unavailable evidence | A valid blocked observation or genuinely insufficient evidence prevents a verdict. Retain the reason and reduced coverage; do not fabricate a score. |

One change can produce several findings. A regression hidden behind a broken
collector needs separate findings and fresh evidence after collection is repaired.
A timeout, import error, malformed output, invalid configuration, or broken setup
is an execution error, even if another item fails or some evidence exists. Never
rewrite it as `fail`, `not_found`, `cannot_judge`, or a zero score. `not_found`
requires confirmed absence from a successful observation.

## Exercise and retain evidence

Validate config and map, inspect affected dry-run selections, then exercise
affected checks plus relevant ordinary regression tests within authorization.
Inspect item-level evidence, coverage, and gates, including unexpected passes.
Record commands, target identities, run paths, evaluator fingerprints, execution
errors, valid abstentions, and unresolved findings separately.

Before replacing active trials for a changed method, copy their complete
references/rationale, old method fingerprint, and reason for supersession into
`.aek-authoring/history/<review-id>.json` (or a history note with the same details).
Keep original run directories and sealed artifacts. Determine affected trials by
their complete evaluator fingerprints, not only the edited check or area. A shared
method, provider, or full-suite receipt can invalidate references on several
requirements. Archive all incompatible references; retain pairs whose current
fingerprints still match. Remove superseded references from the active map after
archiving because status rejects incompatible methods. Run a new known-good and
deliberately defective target with the revised method fixed across the pair;
challenge important checks with a valid variation too. A collection/checker error
does not establish detection. Follow [generation and calibration](generation.md).
If blocked, leave active trials empty as needed and record incomplete calibration.

Finish the review note with completed work, carried/open items and concrete next
actions, final status output, and evidence links. Report **review freshness** as
“inspected scope S at revision R plus recorded working changes, with limits L.”
Historical calibration means the retained examples passed/failed with that method;
it says nothing about newly added interfaces or today's product state. Neither
`ready` nor `calibrated` is a freshness flag. Keep the status schema and CLI intact.
