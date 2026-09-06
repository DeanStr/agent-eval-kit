# Files, checkpoints, and explicit evaluation scope

AEK retains downloaded and command-produced files as evidence. A file receipt
records its label, original filename, declared MIME type, byte length, SHA-256,
and collection step. Browser downloads also record the URL and active persona.
Retained files and metadata participate in the existing artifact index, resume,
collect/judge, and private JSON/HTML reports. Public exports omit file contents,
filenames, URLs, workflow values, and checkpoint evidence.

## Browser downloads

In a browser scenario, instruct the agent to call `download(ref, label)` on the
export control, with a unique label such as `review-results`. The tool waits for
an actual browser download and retains at most 20 MiB. An absent, failed,
off-origin, oversized, or timed-out download returns a tool error. It never
substitutes a success toast for file evidence. All download origins must be
explicitly allowed, including a separate export host if the product uses one.

The MIME type comes from the observed response; when unavailable (for example,
a browser-generated blob), it is recorded as `application/octet-stream`.
MIME metadata is not proof that the bytes have that format. UTF-8 text, JSON, and
XML response types include an at-most-8,000-character preview with an explicit
truncation flag. Invalid UTF-8 in a declared text format is an extraction error.
Binary metadata and truncated excerpts cannot prove full-file content claims.

Declare a file output to pass the retained download to another scenario:

```yaml
- id: EXPORT
  name: Export review results
  kind: browser
  instructions: |
    Export the results with download, labeling the file review-results.
    Publish the returned file path as results using publish_output;
    cite the successful download step as step:N.
  outputs:
    results: { type: file }
```

A file output must refer to a retained file and cite its collection step; it
cannot name an arbitrary local path. Files are available to command graders in
`$AEK_RUN_DIR/<scenario>/files/`, with metadata in that scenario's `evidence.json`.
File outputs require browser or command collection. Bound file inputs currently
require a command collector; browser uploads still use declared fixtures, and
workspace tools inspect project files. Unsupported bindings fail validation.

## Deterministic file checks

The packaged `agent-eval-kit/evidence/files` module provides:

- `readEvidenceFile(scenarioDirectory, fileReceipt)`: verifies containment, size,
  and hash before returning bytes.
- `inspectEvidenceFile(scenarioDirectory, fileReceipt, format)`: verifies bytes
  and returns parsed JSON, CSV rows, ZIP entry metadata, or binary size/hash.
- `parseCsv(bytes)` and `inspectZip(bytes)`: format inspection helpers.

CSV parsing supports quoted fields, escaped quotes, embedded newlines, and
consistent column counts. ZIP inspection checks decompressed sizes and CRCs and
returns each entry's name, byte length, and SHA-256 without extracting paths.
Filename decoding follows the ZIP UTF-8 flag, using CP437 when it is unset and
strict UTF-8 when it is set. It supports stored/deflated single-disk ZIPs, at most 1,000 entries and 20 MiB of
expanded contents. Encrypted, ZIP64, malformed, or unsupported archives fail
explicitly. XLSX, PDF, and calendar semantics require a project-owned parser/checker;
ZIP integrity alone does not establish spreadsheet correctness.

Use these helpers inside a command grader that compares against independent
expected data. Declare the checker and its project-owned dependencies and
expected-result files in `methodFiles`. AEK's supplied helper is versioned with
the kit. Valid content mismatches are product failures; missing evidence or
checker execution errors must not be disguised as a fabricated score.

Run the offline example from this repository:

```sh
pnpm build
pnpm aek run --config examples/files/evalkit.yaml
```

It exports two records and independently checks the actual CSV contents. It
uses command collection and grading, so no browser or model invocation is needed.
Change a score in `examples/files/records.json`, leaving `expected.json` unchanged,
to observe a content failure.

## General command evidence and bindings

Command collectors can produce observations, structured data stored as JSON files,
files, images, and typed scalar/file outputs. Static `sources` and image declarations
are optional; each declared file/image must appear exactly once on completion.
Undeclared and duplicate labels fail execution. Source snapshots and method files
retain their existing fingerprint and integrity checks.

```yaml
- id: CHECK-EXPORT
  name: Inspect exported results
  kind: command
  dependsOn: [EXPORT]
  inputs:
    results: { from: EXPORT, output: results }
  outputs:
    rowCount: { type: number }
  instructions: Inspect the bound export and report its row count.
  collect:
    command: node evals/inspect-export.mjs
    methodFiles: [evals/inspect-export.mjs]
```

The collector reads `$AEK_COLLECT_CONTEXT`. Besides `sources`, `variables`, and
`outputDir`, the context includes declared `files`, `outputs`, `checkpoints`, and
bound `inputs`. Scalar inputs expose `value` and upstream provenance. A file input
also exposes its receipt as `file` and the absolute `path` of a verified, read-only
copy within the consuming scenario. The copy is checked again after execution.

Write one exact JSON manifest to stdout and exit zero:

```json
{
  "version": 1,
  "outcome": "completed",
  "summary": "Inspected the export",
  "observations": ["The export has two data rows"],
  "outputs": { "rowCount": { "value": 2, "evidenceRefs": ["step:1"] } }
}
```

`step:1` is the successful collector execution, whose manifest is retained.
Collector outputs and observations are explicitly project-supplied claims;
execution provenance does not independently establish their truth.

For a produced file, declare its label in `collect.files`, write bytes under
`outputDir`, and add a manifest entry:

```json
{
  "files": [{
    "label": "results",
    "path": "results.json",
    "filename": "results.json",
    "mediaType": "application/json"
  }],
  "outputs": { "results": { "value": "results", "evidenceRefs": ["step:1"] } }
}
```

The file output's manifest value is its returned **label**; AEK resolves it to
the retained path. Browser `publish_output` instead uses the path returned by
`download`. A command collector claiming completion must return every required
output; missing outputs are execution errors. Report `blocked` explicitly when
outputs cannot be obtained, so dependent scenarios do not run. Malformed types, invalid references, changed
bound files, and process failures abort execution with retained diagnostics.

Successful download, checkpoint, and output publication steps must have matching
metadata. Missing metadata after successful publication is an execution error,
not an empty collection or reduced coverage. Collections may be absent when
execution never published them.

## Checkpoints preserve exercised checks

Declare named checks and bind rubric items to them:

```yaml
scenarios:
  - id: FLOW
    name: Save and notify
    instructions: |
      Save the record, reload, and inspect the persisted value.
      Record checkpoint saved with references to the successful evidence steps.
      Then send the notification and inspect its delivery state.
      Record checkpoint notified with its evidence steps.
    checkpoints:
      saved: The saved value was inspected after reload.
      notified: Notification delivery was inspected.
rubric:
  - id: PERSISTENCE
    criterion: The saved value survives reload.
    weight: 1
    scenarios: [FLOW]
    checkpoints: { FLOW: [saved] }
    grader: { type: llm }
    passCriteria: The reloaded value matches the submitted value.
```

`checkpoint(name, evidenceRefs)` records reach, never pass/fail. References must
identify successful earlier evidence actions, excluding observations, persona
switches, and output/checkpoint declarations themselves. Checkpoints cannot be
overwritten. Multiple selectors for one scenario must all be exercised.

If notification is subsequently blocked, the persistence criterion can still be
judged from the saved checkpoint. Its judge may cite only that checkpoint, its
referenced steps, and files/images from those steps. An unrecorded checkpoint
reduces coverage even if the overall scenario says completed. Provider crashes,
invalid outputs, and corrupt checkpoint records remain execution errors.

Checkpoint selectors support LLM/hybrid grading and materialize across case
matrices. Browser/workspace agents use the tool; command manifests can declare
`"checkpoints": {"saved": {"evidenceRefs": ["step:1"]}}`. Controlled visual captures
retain their separate reset and capture contracts. Checkpoints do not release
downstream scenario dependencies: those still require full completion and all
required outputs.

## Explicit applicability

A rubric item can declare its scope before execution:

```yaml
applicability:
  applicable: false
  reason: This declared product tier excludes AI-assisted review.
```

The item receives no verdict and contributes neither score nor coverage weight.
Reports separately list excluded item IDs, weights, and reasons. An entirely
excluded area is retained for scope reporting but has no influence on headline
score/coverage. A selection with no applicable rubric items fails before execution.
Scenarios used only by excluded criteria are omitted unless another scenario needs
them as prerequisites. Critical gates cannot be excluded.

These declarations belong to the evaluator, not the judge or the product agent.
A missing required capability remains `not_found`/`fail`; lack of evidence remains
`cannot_judge`. All declarations are retained in snapshotted specs and fingerprinted:
changing scope makes comparisons incompatible. Public exports include the declared
exclusions, subject to the existing privacy lint.
