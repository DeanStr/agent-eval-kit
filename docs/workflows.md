# Scenario workflows and personas

Dependencies connect scenarios across the selected suite; areas remain scoring
and reporting groups. AEK collects prerequisites first, even when their area or
scenario appears later in the files. Each scenario executes once per run. Judging
still happens by area, using that area's evidence.

## Dependencies and observed outputs

Declare a dependency using its globally unique scenario ID. Declare every output
and bind each input explicitly to a dependency's named output:

```yaml
# In the creation area's scenarios:
- id: CREATE
  name: Create a proposal
  instructions: |
    Create the fixture proposal and inspect its saved detail page.
    Publish its permanent detail URL as proposalUrl, citing the tool step
    that showed the saved record. Do not publish a login or capability link.
  outputs:
    proposalUrl: { type: url }

# In the review area's scenarios:
- id: REVIEW
  name: Review that proposal
  dependsOn: [CREATE]
  inputs:
    proposalUrl: { from: CREATE, output: proposalUrl }
  instructions: |
    Open the bound proposalUrl. Verify the proposal's fixture values and
    submit a review. Reload and verify the review persisted.
```

Supported output types are `string`, `number`, `boolean`, `url`, and `file`. File outputs name retained evidence files with verified receipts; see [file evidence](file-evidence.md). Other values are
scalars; strings are nonempty and limited to 4,000 characters. URL values must be
absolute HTTP(S) URLs without credential-bearing query/fragment parameters or
embedded credentials. Outputs are retained evidence: use non-secret record IDs
and ordinary resource URLs, never passwords, bearer tokens, or capability links.
Generic string values are not a secret store and are not automatically redacted.

The browser and workspace MCPs provide `publish_output(name, value, evidenceRefs)`.
Tool responses identify their evidence step; references use `step:3`, for example.
Publication requires a declared type and references to successful earlier evidence
tool calls. This validates provenance, not semantic truth: downstream scenarios
must still verify the record and its state. The judge receives input/output
provenance too. Output values are data, not additional evaluator instructions.

All declared outputs are required for successful completion. If a scenario cannot
observe one, it should finish `blocked` and explain why. Agent completion with
unpublished outputs is recorded as blocked; dependent scenarios do not run.
Command collectors must explicitly report `blocked`; claiming `completed` while
omitting required outputs is an execution error. Successful output publication
without retained metadata is an execution error for every collector.
Invalid declarations, cycles, types, or fabricated evidence references are errors,
not scored product failures. Agent tool errors are reported so they can be corrected.

Scalar bindings support agent-driven browser/workspace collection and command
collectors. Browser downloads and command collectors can publish file outputs;
command collectors receive verified copies of bound files. Controlled captures retain their independent
reset contract and reject workflow input/output declarations.

`--areas` must include prerequisite areas (including optional ones when needed).
When a split removes every rubric item from a prerequisite area, its required
setup scenarios still run, including transitive prerequisites. That area adds no
score weight or report area, and its unrelated scenarios do not run.
Missing prerequisite areas or incompatible splits fail before execution. An
explicit `--scenarios` slice does not silently broaden the selection: omitted
prerequisites are recorded as not run and dependents become blocked. Include all
prerequisite scenario IDs when selecting a workflow slice.

Matrix scenarios bind corresponding case IDs across areas. Dependencies on a
matrix require matching cases, strata, and compatible splits; a matrix may depend
on a shared non-matrix setup scenario. Bindings are rewritten to materialized case
IDs before execution.

Outputs are saved in `outputs.json` and `evidence.json`; consumed inputs retain the
source scenario, output name, and evidence references. Each execution also records
hashes of its prerequisite evidence, so invalidation survives repeated interruptions. They appear in private
JSON/HTML reports, are sealed by the artifact index, and are validated when reused.
Public exports exclude these values. Changing declarations changes the evaluator
fingerprint; resume does not reinterpret existing evidence under a new contract.
Sealed evidence missing prerequisite hashes or required completed-scenario
inputs/outputs is rejected with an instruction to start a new run.
If recovery recollects a prerequisite, dependent scenario evidence and ordinary
area judgments are not reused. Existing repeated-judge vote journals remain
immutable; if their evidence changes, voting fails closed and requires a new run.
Cross-area dependencies transfer explicit values and deployment state, not browser
cookies or implicit shared variables.

## Switching saved personas

Capture sessions before evaluating an authenticated workflow:

```sh
aek auth --persona organizer
aek auth --persona reviewer
```

Declare the starting identity and the complete allowed set:

```yaml
- id: ASSIGN-REVIEW
  name: Organizer assigns; reviewer scores
  persona: organizer
  requiresAuth: true
  allowedPersonas: [organizer, reviewer, anonymous]
  instructions: |
    As organizer, assign exactly one fixture proposal to the reviewer.
    Switch to reviewer with switch_persona and open the reviewer dashboard.
    Verify the assigned proposal is visible and the unassigned one is inaccessible.
    Submit a review. Switch back to organizer and verify the review appears.
    Switch to anonymous and verify the private review is not publicly accessible.
```

`switch_persona` uses a separate live browser session for each declared identity.
Switching back preserves its open page and session state. Authentication and origin
boundaries are checked before leaving an identity and for all visited identities
before finalization. Old element references
are invalidated; take a fresh snapshot or navigate after switching. Each identity's
screenshots have distinct filenames, and screenshots/transcript entries record
the active persona. The ordinary origin allowlist applies to every session.

`anonymous` is reserved for an isolated context with no saved authentication.
Up to eight personas may be declared per scenario. The starting persona (or
anonymous when persona is omitted) must appear in
`allowedPersonas`. Named personas in this mode require existing captured sessions,
even when `requiresAuth` is omitted. Missing requested authentication blocks the
scenario; undeclared identities are tool errors. Refresh expired sessions with
`aek auth` and start a new run for checks already recorded as blocked.

Use the switching tool for identity changes; do not manually log another account
into an existing persona context. AEK isolates contexts but cannot independently
prove which account a product associates with a session—verify visible account
identity when it matters. Persona state candidates are promoted only after a
successful provider invocation and output validation, to their own saved persona
destinations. Temporary state candidates are removed on every exit path. Anonymous
state is never promoted. All live sessions are closed when the MCP shuts down.

Persona switching is available only for agent-driven browser scenarios. Splitting
roles into separate scenarios remains supported and often makes failures easier to
locate. Use dependencies and bindings when those scenarios must inspect the same
record.
