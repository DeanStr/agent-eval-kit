# Public export and privacy lint

Run directories retain private evidence: prompts, transcripts, screenshots,
provider events, and fixture data. Share results through a deliberately lossy
public export instead.

## Create a public export

Create a small shareable package from an integrity-verified run:

```bash
aek export --public --run .agent-eval/runs/<timestamp>
```

The default destination is `.agent-eval/exports/<run-id>/`. The export contains aggregate, area, rubric, case, stratum, split, provider, source-hash, and gate outcomes. It deliberately excludes target URLs and absolute paths, fixtures and case variables, prompts and evaluator instructions, transcripts and observations, screenshots and provider events, defects and notes, evidence references, and grader reasoning. `--public` is required so this lossy boundary is explicit.

## Privacy lint

Before publishing atomically, AEK scans every exported text file for private keys, bearer and known API-token formats, probable secret assignments, email addresses, user home paths, and credentials embedded in URLs. Findings name only the rule and file/line; they never echo the matched value. A failed scan publishes nothing. You can run the same heuristic scanner independently:

```bash
aek privacy lint --path path/to/proposed-artifact
```

The lint is a guardrail, not proof of anonymity: product-specific customer IDs or sensitive business labels may not match a generic pattern and still require human review. Binary files are skipped and counted; public exports contain no binary evidence by design.

A standalone `aek privacy lint` with findings exits with status `2`; see
[exit statuses](cli.md#exit-statuses).
