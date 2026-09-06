# Evaluate a dataset of related texts

These are synthetic fixtures, not measured editorial results. One JSON dataset
supplies three independent suites: authorial voice, editorial quality, and
coherence/factual fidelity to a supplied record. Each case groups a post and its
social copy; the policy grader sees both together.

From the repository root:

```sh
pnpm aek validate --config examples/text-datasets/evalkit.yaml --suite policy
pnpm aek run --config examples/text-datasets/evalkit.yaml --suite voice --judge codex
pnpm aek run --config examples/text-datasets/evalkit.yaml --suite quality --judge codex
pnpm aek run --config examples/text-datasets/evalkit.yaml --suite policy --judge codex
```

Omit `--judge codex` to check the wiring with the mock. Mock judgments abstain,
with zero coverage and exit status 2. The default split is `development`; use
`--split evaluation` explicitly for reserved cases. Each suite has its own
report, score, coverage, and gates.

Text sources can be inline `{text: ...}` objects, project-relative file paths,
or named promoted references. Dataset manifest paths resolve from the spec;
text file paths resolve from `project.root`. External datasets are embedded in
run snapshots, so detached-run rescore does not need the original manifest.

After a full run, edit one case and pass `--changed-since <prior-run-directory>`
to evaluate only cases whose inputs or judging method changed. Skipped cases
remain unavailable and reduce coverage. No historical scores are copied into
the new report. Use a full run for release promotion.

See [text evaluation](../../docs/text-evaluation.md) for templates, suites,
reference promotion, and selection details.
