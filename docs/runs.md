# Run, recover, and review evaluations

This guide covers executing an evaluation, recovering interrupted runs, applying
scoring changes and human review, enforcing CI thresholds, and the retained
artifact layout. See the [command guide](cli.md) for every flag and exit status,
and [comparisons and campaigns](comparisons.md) for comparing runs.

## Start a run

Validate and preview the evaluation before spending provider quota:

```bash
aek validate
aek list
aek run --dry-run
aek run
```

For a one-off target or a cheaper bounded pilot, override the configured web URL and scenario interaction budget. Claude and Grok enforce this as provider turns; Codex, whose CLI has no turn-limit flag, enforces it as a hard MCP tool-call limit:

```bash
aek run --url https://preview.example.test --max-turns 20
```

Use different subscriptions for collection and judgement:

```bash
aek run --agent codex --judge claude
aek run --agent claude --judge grok
```

Run only a slice:

```bash
aek run --areas checkout,account --scenarios CART-S1,CART-S2
aek run --split development
aek run --split evaluation
```

Artifacts go to `.agent-eval/runs/<timestamp>/`. Open `report.html` for the evidence-backed report and keep `report.json` as the stable machine-readable result.

For expensive captures or judge calibration, collect once and create separate judged runs:

```bash
aek collect --split all
aek judge --evidence .agent-eval/runs/<collection-id> --judge claude
```

See [collecting and judging separately](evidence-workflows.md) for evidence
compatibility, rubric changes, recovery, and baseline promotion policies. To
compare judge configurations against separately reviewed labels, see
[judge validation](judge-validation.md).

## Resume an interrupted run

Each completed scenario writes `evidence.json` atomically. Every completed area rebuilds the report, so a late provider or browser failure does not lose earlier work.

```bash
tail -f .agent-eval/runs/<timestamp>/run.log
aek run --resume .agent-eval/runs/<timestamp>
```

Resume reuses non-error scenario evidence and completed area judgements. It requires the current run-state format and its input fingerprint, and refuses changed resolved configuration, provider/evaluator method, selected areas or scenarios, exact spec bytes, fixture manifest or named fixture bytes, and a changed clean Git revision. An exclusive per-run lock rejects concurrent resume or execution before recovery can alter artifacts. Start a new run for changed or unverifiable evaluation inputs.

## Receipts and provider settings

Every report embeds a versioned receipt and writes the same data to `receipt.json`. It records SHA-256 checksums for evaluation inputs, provider CLI versions, kit/runtime versions, target Git revision when available, and two fingerprints: a strict input fingerprint for resume and an evaluator fingerprint for safe cross-target comparison. Receipt creation fails if a configured provider's CLI version cannot be determined; run `aek doctor` instead of producing an unverifiable receipt. Receipt files contain hashes and metadata, not fixture contents or secrets.

Pin `agent.model`, `judge.model` and their `effort` settings for comparisons.
The report's provider table shows the requested model, reasoning effort and CLI
version from the retained receipt; JSON retains these under `providers.agent`
and `providers.judge`. Changing model or effort changes the evaluation
fingerprint. Omitted settings appear as `Provider default (unrecorded)` in HTML.
Rebuilding a report from retained evidence preserves the receipt's provider
settings, even when the current configuration has changed.
These fields record requested settings, not a provider-confirmed model snapshot:
Codex's current `exec --json` stream does not expose that resolved identity.
The exact invocation argv is retained in `provider-run.json`, with explicit
`requestedModel` and `requestedEffort` fields for browser/workspace collection
and ordinary LLM judging. Pinning a model ID does not make model output
deterministic or freeze a provider's implementation of that ID.
See [provider behavior](providers.md) for each adapter's invocation contract.

## Rescore after scoring changes

After changing only scoring weights/tags, intentionally apply the current specs without a model call. Rescore requires the sealed original resolved-config snapshot and uses its original scoring values when checking that no unrelated collection settings changed:

```bash
aek rescore --run .agent-eval/runs/<timestamp>
```

## Finalize manual checks

For pending manual checks, either answer prompts:

```bash
aek finalize --run latest --interactive
```

or edit `manual-results.json`, setting each `verdict` to `pass`, `partial`, `fail`,
or `not_found`, then:

```bash
aek finalize --run latest --reviewer dean
```

`--interactive` asks for a reviewer name (defaulting to the operating-system
username), then shows each pending item's criterion, pass criteria, verification
instructions, and any automatic evidence, and asks for a verdict and optional notes.
Answers may also be piped on stdin, one per line. Skipped items stay pending.
The reviewer applies to the answers entered in that prompt session; earlier
finalized decisions keep their original reviewer and revision.
Ctrl-C or SIGTERM while answering discards the unfinished answer batch and
releases the run lock. With `--json`, interruption returns an `interrupted`
envelope and exit status 130 or 143.
Without `--interactive`, finalize fails with the pending item IDs when
`manual-results.json` still holds only the placeholder verdicts.

Finalization appends a hashed entry to `manual-revisions.ndjson` for every changed manual or hybrid result. Each revision records its reviewer, timestamp, verdict, notes, and the previous revision hash. Re-running finalize without a change does not create a duplicate revision. Unknown rubric IDs and invalid completed verdicts are rejected. If `--reviewer` is omitted, AEK uses the reviewer saved in the entry or the local operating-system username; if none is available, finalization requires `--reviewer` instead of recording an anonymous revision.

## Adjudicate automatic abstentions

For automatic `cannot_judge` results, review `adjudication-checklist.md` and create a decision file outside the run directory:

```bash
aek adjudicate --run .agent-eval/runs/<timestamp> --input decisions.json --reviewer dean
```

Adjudication requires a named reviewer, rationale, and supporting evidence. It preserves the original automatic result, distinguishes newly supplied human evidence from collected artifacts, and appends hashed revisions to `adjudications.ndjson`. Hybrid automatic and manual shares remain separate. See [human adjudication](adjudication.md) for the input format, corrections, and scoring behavior.

## Verify artifact integrity

Every report update also writes `artifact-index.json`, which checksums retained inputs, evidence, screenshots, provider events, judgements, review history, and reports. Verify a run explicitly with:

```bash
aek verify --run .agent-eval/runs/<timestamp>
```

Resume, compare, rescore, finalize, adjudicate, and baseline promotion verify an existing index before trusting its artifacts. `manual-results.json`, `run-state.json`, `run.log`, temporary files, and generated comparisons are documented mutable exclusions; finalized review revisions and rebuilt reports are sealed into the next index.

## CI thresholds

Add score and evidence-coverage gates directly to a run:

```bash
aek run --fail-under-score 85 --fail-under-coverage 90
```

The same flags work with `rescore` and `finalize`. Critical rubric items marked `gate: true` are always enforced as hard gates. Artifacts are written first; any failed or unavailable critical gate or numeric threshold exits with status `2`. A withheld or unavailable score cannot pass `--fail-under-score`, even if its provisional numeric value is high. Invalid thresholds and execution errors use status `1`.

Run, rescore, and finalize thresholds and score withholding use full-precision weights, allowing only machine-level arithmetic roundoff at equality. Display percentages are rounded: a displayed 100% may still fail a 100% requirement; the failure message includes the unrounded measurement.

See [exit statuses](cli.md#exit-statuses) for the full distinction and
[critical gates](specs.md#critical-gates) for gate semantics.

## Artifact layout

```text
.agent-eval/runs/<timestamp>/
├── inputs/                       # resolved/redacted config and exact spec copies
├── receipt.json                  # input hashes, method/runtime metadata, fingerprints
├── artifact-index.json           # hashes for retained generated artifacts
├── run-state.json                # resume metadata and strict input fingerprint
├── run.log
├── <scenario-id>/
│   ├── prompt.md
│   ├── evidence.json
│   ├── provider-events.ndjson
│   ├── provider-stderr.log
│   ├── browser-transcript.ndjson      # or workspace-transcript.ndjson
│   └── screenshots/*.jpg
├── areas/<area-id>/
│   ├── graders/*
│   └── _judge/*
├── report.json
├── report.html
├── manual-checklist.md
├── manual-results.json           # editable review input; intentionally not sealed
├── manual-revisions.ndjson       # append-only hashed review history
└── comparisons/vs-<baseline-run-id>/
    ├── comparison.json
    └── comparison.html
```

Campaigns are stored beside the configured runs directory under `campaigns/<timestamp>/`. Promoted baselines use `paths.baselines` (default `evals/baselines`) and are stored under `<name>/`: `current.json` points to the latest immutable snapshot while earlier snapshot directories remain intact.

Run state retains one-off provider, model, URL, turn-budget, scenario, area, and split selections so `aek run --resume <run>` reproduces the original invocation without requiring flags to be repeated. For Git targets, clean commits identify clean trees; dirty trees also receive an exact content fingerprint. AEK-owned run/auth/baseline/campaign paths are excluded so harness output cannot invalidate its own resume or repeated campaign.

Public exports are stored beside runs under `exports/<run-id>/` by default. Campaign comparisons are written below the candidate campaign under `comparisons/vs-<baseline-campaign-id>/`.
