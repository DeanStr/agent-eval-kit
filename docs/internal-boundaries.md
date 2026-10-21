# Internal boundaries

`src/runner.ts` coordinates scenario execution, area judging, and incremental reports. Supporting run concerns live under `src/run/`:

- `state.ts` validates saved state and owns exclusive run locks. Offline commands depend on this module directly, without importing the evaluator.
- `recovery.ts` verifies sealed artifacts, removes recoverable partial writes, and determines which prior artifacts can be reused. Completed vote journals remain immutable.
- `inputs.ts` validates and snapshots evaluation inputs and enumerates evaluator-only files for workspace containment.
- `receipt.ts` owns the canonical receipt across lifecycle and command execution. It prevents target mutations from silently rebinding reusable evidence or changing the evaluator.

`src/receipts.ts` constructs fingerprints. `src/judging/command-inputs.ts` defines command grader file provenance and verifies checker snapshots against executed files. Collectors and graders share bounded file hashing through `src/input-files.ts`.

`src/browser/session.ts` owns browser lifetime, page and frame references, snapshots, origin enforcement, and screenshot capture. Interaction handlers receive explicit subsets of `BrowserInteractionContext`:

- `forms.ts` handles text fields, rich-text editors, and native/custom dropdowns.
- `pointer.ts` handles clicking, dragging, keyboard actions, and scrolling.
- `uploads.ts` handles native file inputs and styled upload controls.

Handlers resolve the current page and frame maps through the session. They call the same origin checks as before; no handler creates its own browser state or origin policy. Browser inspection and input-operation failures propagate as execution errors. Styled uploads try another input only when the chooser wait times out after a successful click; failures while clicking, checking origins, or setting files are not retried on unrelated inputs. Configured fixture snapshots also fail if the source file disappears. The MCP and full browser regression suites exercise these boundaries through the public session API.

`src/score-slice.ts` computes full-precision ratios and area aggregates. Scoring rounds percentages only when constructing display fields; CI and score withholding share an unrounded comparison that tolerates only floating-point arithmetic noise at equality. The tolerance scales with the compared values (about 3.6e-13 percentage points at 100%), independently of display precision.


`src/visual/direct.ts` validates and stages a single imported-image comparison,
then uses the normal runner and sealed vote journals. `src/visual/batch.ts`
coordinates these same runs with a bounded queue and consolidated reports.
It stores cases under `pairs/` because the general run index reserves and excludes
`comparisons/`. Its retained input index protects generated configs, collectors and image bytes;
completed comparison indexes protect results reused across batches. A final batch
index also seals the combined report; live execution retains the input index and
completed vote seals until its next checkpoint. Exact contract
fingerprints include runtime and provider identities, independently of labels
and original file locations. Application-specific capture remains outside this
workflow.

`src/providers/capacity.ts` wraps judge invocations only when capacity retries
are enabled. It classifies explicit temporary capacity diagnostics, archives
failed attempts and inspection transcripts, and uses cancellable bounded backoff.
Adapters still own output validation; valid decisions, malformed adapter output,
policy violations and ordinary execution failures never trigger capacity retries.
Provider results identify text originating from an explicit CLI error envelope;
nonempty, unparseable model answers are execution errors even when a separate
capacity diagnostic is present. Error diagnostics never override a parsed decision.
Adapters also record completed assistant responses and structured-output calls
independently of terminal results, so a later overload cannot erase an emitted
answer and trigger an automatic reroll.
