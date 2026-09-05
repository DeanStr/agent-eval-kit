# Shared judging contracts

The harness applies shared evidence rules before scoring. Provider execution, vote counting, product verdicts, and manual score components remain distinct.

| Rule | Implementation | Used by |
| --- | --- | --- |
| Exact rubric/case identity sets, with no omissions, additions, or duplicates | `src/judging/contracts.ts` | Single rubric responses, repeated responses and saved votes, generated pairwise results |
| Stable case requests and canonical evidence references | `src/judging/evidence.ts` | Prompt construction, rubric normalization, pairwise case results |
| Scoped citations, reached case evidence, and claim validation | `src/judging/rubric.ts` | Single rubric responses and every fresh repeated response |
| Successful image access and strict MCP transcript validation | `src/evidence/inspection.ts` | Ordinary screenshot citations and pairwise panel inspection |
| All-member verdict aggregation and constraints on full pass | `src/judging/contracts.ts` | Single/repeated rubric case constraints and pairwise scenario/reference/case aggregation |

Identity, citation, and image-access violations are execution errors with retained diagnostics. Unknown or out-of-scope citations, non-abstaining verdicts without citations, and defects without reached evidence are rejected. Explicit `cannot_judge` may omit citations. Missing intermediate vote or pairwise results are execution errors. A blocked case cannot be supported by a shared setup scenario alone. Explicit abstention reduces coverage and never becomes a fabricated failure.

## Aggregation

A derived aggregate is unavailable if it has no members or any member is `cannot_judge`. Otherwise, all passes yield `pass`, all `fail`/`not_found` results yield `fail`, and mixed observed outcomes yield `partial`.

Rubric judges supply an independent item verdict. Case results constrain a proposed full pass; they cannot upgrade or overwrite a non-pass verdict. Single and repeated judging use the same constraint. Pairwise judgments derive their result from every required reference and scenario, so they apply the aggregate directly. Deterministic checks and manual/hybrid score components retain their own explicit contracts.

## Image access

Rubric claims require access to the screenshots they cite. Text-only verdicts and explicit abstentions need no image view. Pairwise non-abstaining decisions require both anonymous panels; viewing only the chosen image is insufficient. Codex receives selected images as direct attachments; MCP-based judges must successfully request them. Failed views and unselected images never establish access. A fresh ordinary judge clears earlier image-view records when an unfinished area is retried; a completed repeated vote retains its own sealed transcript.

## Regression coverage

`test/judge-contracts.test.ts` exercises single/repeated parity for case aggregation, unknown citations, and identity errors, along with the shared image-access policy and its different required image sets. `test/visual-contracts.test.ts` and `test/visual-integration.test.ts` cover pairwise validation and interrupted judging. `test/first-run.test.ts` executes the introductory walkthrough and checks its report measurements and exit statuses.
