# Capabilities

AEK combines an evidence source with a grader, then reports score and evidence
coverage separately. See [evaluation types and boundaries](evaluation-types.md)
to choose a combination for a particular question.

It supports:

- deployed web apps and local web apps (managed setup/start/readiness);
  see [target configuration](configuration.md#project-and-target);
- repositories and command-line projects; see [starters](onboarding.md#choose-a-starter);
- black-box browser scenarios through a shared Playwright MCP server and path-contained repository inspection through a read-only workspace MCP server;
  see the [evidence and safety model](deployment.md#evidence-and-safety-model);
- deterministic command graders, independent LLM judges, manual graders, true weighted hybrid graders, and critical pass/fail gates;
  see [grader types](graders.md) and [critical gates](specs.md#critical-gates);
- controlled visual capture, independent motion/repeatability tolerances, image-health and scoped distinctness checks, opt-in image-statistic baseline gates, blind pairwise image graders, and resumable repeated judging;
  see [visual evaluation](visual-evaluation.md) and [image comparison](image-comparison.md);
- direct text comparisons and rubric grading, reusable datasets/templates, grouped case results, named suites, promoted text references, and changed-case selection with verified quotations;
  see [text evaluation](text-evaluation.md);
- command collectors for exported artifacts with snapshotted sources, validated image manifests, and extraction provenance; named capture checkpoints for irregular temporal sampling;
  see [command collection](visual-evaluation.md#command-collection-of-exported-artifacts) and [named temporal checkpoints](visual-evaluation.md#named-temporal-checkpoints);
- immutable collect-then-judge bundles, explicit release/milestone promotion policies;
  see [separate collection and judging](evidence-workflows.md) and [promotion policies](evidence-workflows.md#baseline-promotion-policy);
- incremental artifacts, fingerprint-checked resume, reproducibility receipts, tamper-evident output indexes, offline rescore, auditable manual finalization, coverage thresholds, and diagnostic tags;
  see [run, recover, and review](runs.md);
- downloaded and command-produced file evidence, typed file/scalar workflow bindings, evidence-backed checkpoints, and explicit applicability exclusions;
  see [file evidence](file-evidence.md) and [scenario workflows](workflows.md);
- parameterized case matrices, diagnostic strata, and fingerprinted development/evaluation splits;
  see [case matrices](specs.md#case-matrices-strata-and-splits);
- repeated-run campaigns with rubric/case/stratum stability, whole-run bootstrap intervals, and paired case-level campaign comparisons;
  see [campaigns](comparisons.md#repeated-run-campaigns);
- reusable [prompt/skill experiments](../examples/skill-comparison/README.md) and [project-owned benchmarks](../examples/benchmark/README.md), retaining every attempt and measurement changes alongside correctness gates;
- explicit counterbalanced multi-candidate benchmark experiments through `aek benchmark experiment`, with shared resource exclusion and per-block differences;
  see [controlled benchmark experiments](cli.md#controlled-benchmark-experiments);
- compatibility-checked comparisons and append-only promoted baseline snapshots;
  see [comparisons and baselines](comparisons.md);
- minimal public exports with an automatic privacy lint that never echoes matched secret values;
  see [public export](public-export.md);
- interchangeable agent and judge providers, so you can use Codex to test and Claude, Grok, or Cursor to judge;
  see [provider behavior](providers.md).

## Guided authoring and bounded improvement

The `aek-author` skill supports project discovery, focused interview rounds,
saved decisions, existing-kit updates, and good/defect calibration. See
[project authoring](authoring.md).

For an existing deterministic suite, use [bounded project improvement](improvement.md):
`aek improve install` adds `$aek-improve`, which guides hypothesis-driven edits
through full-suite acceptance and preserves the best checkpoint in its own Git
worktree. Rejected candidates retain their evidence and are restored automatically.
Incremental improvements may remain below the release bar. Acceptance defaults to
single runs with strict regression checks; `--repetitions n` evaluates each candidate
as a campaign and requires a paired-case bootstrap gain for noisy LLM-judged suites.

Compare judge configurations against separately reviewed evidence labels with
[judge validation](judge-validation.md).
