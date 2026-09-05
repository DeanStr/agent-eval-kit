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
