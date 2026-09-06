# Human adjudication of automatic abstentions

Use `aek adjudicate` when a completed evaluation contains an automatic `cannot_judge` result and a human can supply a supported verdict. It works with automatic rubric graders, including the automatic share of a hybrid criterion. The report retains the original automatic result and records the human decision separately.

Inspect `adjudication-checklist.md` in the run directory for eligible criteria, their original reasoning, and the current revision hash. Review the full automatic criterion, including its pass criteria and any required cases or checkpoints.

Create a decision file **outside the run directory**:

```json
{
  "schemaVersion": 1,
  "decisions": [
    {
      "areaId": "checkout",
      "itemId": "CHECKOUT-07",
      "previousRevision": null,
      "verdict": "pass",
      "rationale": "Verified the confirmation email after completing checkout in the test tenant.",
      "evidence": [
        {
          "kind": "human",
          "path": "review/confirmation-email.txt",
          "description": "Confirmation email saved during human verification",
          "observedAt": "2026-09-06T10:00:00Z"
        }
      ]
    }
  ]
}
```

Then run:

```bash
aek adjudicate --run .agent-eval/runs/<timestamp> \
  --input decisions.json --reviewer alice

aek verify --run .agent-eval/runs/<timestamp>
```

`--reviewer` must be explicit and nonempty. Every decision needs a nonempty rationale. Resolved verdicts are `pass`, `partial`, `fail`, and `not_found`, and require at least one supporting artifact. Partial verdicts use the configured partial-credit value. Unknown fields, duplicate items in a batch, missing artifacts, stale revisions, and unsupported criteria fail before any decision is published. A batch supports up to 100 decisions and 20 evidence references per decision.

## Evidence and provenance

Two evidence forms distinguish the original collection from later human observations:

- `kind: "human"`: `path` resolves relative to the decision file, or can be absolute. Supply a description and an ISO 8601 `observedAt` timestamp with a timezone, no later than the review time. AEK copies the bytes into `adjudication-evidence/<sha256>` and records the original filename, size, checksum, and observation time. Files must be nonempty regular files, at most 20 MiB each and 100 MiB total per batch. Symlink files are rejected. Attach only material appropriate to retain in this private run bundle.
- `kind: "collected"`: `path` is relative to the run directory and must identify an already indexed input, evidence, or judgement artifact. Supply a description; AEK records the artifact's existing checksum and size. Reports and prior human-review artifacts cannot be relabeled as original collected evidence.

For example, a human who can resolve an abstention from an existing screenshot can use:

```json
{
  "kind": "collected",
  "path": "checkout-confirmation/screenshots/001.png",
  "description": "Existing screenshot clearly shows the order confirmation"
}
```

Each revision records the reviewer, review time, rationale, evidence receipts, criterion hash, original result and its hash, and the artifact-index root before the update. `adjudications.ndjson` retains all revisions in a hash chain; each revision also identifies the preceding decision for that item. The report embeds the latest decision and the untouched original result, including automatic confidence, reasoning, evidence references, votes, and hybrid components when present. The HTML report displays both decisions and links to supporting evidence and the audit history.

Reviewer names are self-reported. Hashes detect modifications relative to retained records; they are not identity authentication, digital signatures, or an external timestamp authority. Keep a trusted copy of the bundle or its artifact-index root when independent verification matters.

## Corrections and withdrawal

For a correction, set `previousRevision` to the current item's `adjudication.revisionHash` from `report.json` or the checklist. Supply the replacement verdict, rationale, and evidence. AEK appends a revision and preserves all earlier decisions. A stale hash is rejected, preventing an old decision file from silently overwriting a newer review. Use `null` only for a first adjudication.

To withdraw a previous decision, submit `verdict: "cannot_judge"` with the current revision hash and a rationale. Evidence can be empty for withdrawal. This restores unresolved automatic coverage; it cannot be used as a first adjudication.

## Scoring and workflow boundaries

Human adjudication updates the effective rubric verdict, score, coverage, tags, and critical gates. For a weight-4 hybrid with `autoShare: 0.25`, a human pass on the automatic abstention establishes 1 point of judgeable weight. The remaining 3 points still need the declared manual check through `aek finalize`. Existing manual decisions remain in force.

Scenario outcomes, defects, and automatic case/stratum diagnostics retain the original observations. A rubric adjudication does not manufacture successful browser execution or individual case measurements. New human evidence may describe a later application state; its observation timestamp makes that distinction visible. Reviewers should explain how it supports the criterion and target under review.

Only completed runs with existing automatic abstentions are eligible. Execution errors, missing judgement results, decisive automatic verdicts, and declared manual-only criteria cannot be overridden by this command. Repair and rerun broken evaluations. `aek finalize` continues to handle declared manual criteria and hybrid manual shares.

Adjudication requires the current scoring definitions, just like finalization. Use `aek rescore` to apply supported scoring-only changes first. Subsequent rescores and finalization preserve the adjudication and original result. A different criterion requires a new evaluation. The command uses the run lock, verifies artifact integrity, and publishes the report, history, and new evidence through a recoverable transaction. Re-running a report update command completes an interrupted transaction before starting new work.

`--fail-under-score` and `--fail-under-coverage` apply after publishing the updated report, with the same threshold behavior as other report commands. Public exports include the effective verdict and adjudication revision hash, and exclude reviewer identity, rationale, original result snapshots, and supporting evidence. The full run bundle remains private.

Promoted baseline snapshots retain only an `adjudicationReceipt` containing the human verdict and revision hash; private reviewer details, rationale, evidence, and the original result remain in the source run. These redacted snapshots support comparison, but rescoring and further adjudication require the original run.
