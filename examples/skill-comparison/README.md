# Controlled skill comparison

Run project-owned prompt/skill experiments with configurable tasks, instruction
variants, starting files, protected files, submitted outputs, and an external
runner. The default `experiment.json` compares two instructions on a cart task.
This is a bounded workflow, not a scheduler, optimiser, or general skill ranking.
The external candidate adapter uses Codex in Docker. AEK only collects and judges
the resulting artifacts; it does not execute candidate instructions as scenarios.

## Use an application-owned experiment

Keep tasks, data, instructions, instrumentation, and acceptance checks in the
application repository. Pass its definition as the third argument:

```sh
node examples/skill-comparison/run.mjs /tmp/new-trial controls.json /path/to/app/evals/experiment.json
```

Use [experiment.json](experiment.json) as the schema example. All source paths
resolve relative to that definition. Each task declares:

- `task`: a task file installed as protected `TASK.md`.
- `startingState`: destination-to-source mappings for files or directories.
- `protected`: starting paths whose bytes and file membership cannot change.
- `outputs`: workspace-to-evaluator mappings for submitted files or directories.
- `evaluation.config`: an ordinary project-owned AEK config; the workflow sets
  its root and runs directory in an isolated evaluation project.
- `evaluation.files`: destination-to-source mappings for specs, collectors,
  checkers, expected data, references, and their dependencies. Declare every
  executable method in the AEK spec's existing `methodFiles` fields.
- Optional `evaluation.controlFiles`: JSON files containing explicitly named
  public runner controls, such as the pinned observation image. Credential paths
  cannot be copied this way. `evaluation.timeoutSeconds` bounds each AEK command.

`variants` maps stable ids to instruction files; `baseline` names the comparison
baseline. Every other variant is compared with it for each task and repetition.
Tasks have independent fixed evaluators; scores from different tasks are not
pooled into a skill ranking. Output destinations cannot overlap evaluator files.
Symlinks in submitted paths or their ancestors are rejected. The workflow removes
the previous submission before installing the next one.

`runner` names an external module exporting `validateControls(controls)`,
`publicControls(controls)`, and `runCandidate({workspace, directory, controls,
instructions})`. Controls include `repetitions >= 2`; remaining fields belong to
the adapter. `publicControls` must return the full nonsecret execution identity.
`runCandidate` must enforce its budget, retain invocation/stdout/stderr, await
cleanup, and return `{exitCode, durationMs, usage?}` plus execution `error`,
`cleanupError`, or `interruptedSignal` when applicable. Cleanup failure stops new
candidate calls. It must provide the isolation its application requires; the
host orchestrator is not a sandbox. The supplied Docker adapter is the reference.

Mapped and submitted files retain their permission bits, including executable
scripts. Protected inputs and fixed evaluators are checked for mode changes too.
The plan retains starting bytes, hashes and modes, instruction bytes/hashes, runner
identity, and evaluator hashes. Every attempt retains a separate candidate
identity and submitted artifact hashes. Evaluator identity comes from AEK, never
from the candidate model or instruction variant. A `pass`, `requirement_failure`,
`inconclusive`, or `execution_error` outcome accompanies each attempted execution;
blocked evidence reduces coverage and withheld scores are `null`. Unattempted
work is counted separately. Exit status is 0 for complete passing comparisons,
2 for observed failures/inconclusive results, and 1 for execution errors.

See [consumer validation](../../docs/workflow-consumers.md) for Vacation's creator
kit integration and [benchmarking](../benchmark/README.md) for measured workloads.

The task adds a discount while preserving quantity and empty-cart behavior.
`fixture/cart.test.mjs` remains an ordinary runnable Node test suite, visible to
candidates and kept unchanged. The task directs candidates to put additional tests
in separate files. Private checks independently cover
omitted/zero/full discounts and rounding the subtotal once across multiple
quantities and cart lines. Two separate 5-cent lines discounted 50% must total
5 cents; rounding each line separately incorrectly produces 6. The calibration
test retains that defective implementation alongside a correct implementation.
Expected values never come from the implementation under evaluation.

## Setup and run

Use Linux, Docker, Node 20.19+, and an installed AEK package (or `pnpm build` in
this source checkout). Supply an already installed runner image containing Node,
`/bin/sh`, and a compatible `codex` CLI supporting the flags in `docker-runner.mjs`.
Pin its repository digest, so the model runner and available container tools stay
fixed. The example never builds or silently pulls a mutable runner image. Supply
an existing Codex auth JSON file; it is mounted only in candidate containers.
The adapter ignores user config/rules and starts an ephemeral session each time.

Provide a dedicated **internal** Docker network and an HTTP CONNECT proxy on that
network that permits only your model API endpoints. Set `network` and `proxyUrl`
in controls. The adapter checks Docker's internal-network flag before each
candidate, joins only that network, and routes HTTP(S) through the proxy. Configure
the proxy's allowlist outside the candidate image; it must deny public source/code
hosts and other services. Keep other workloads off this network. No general
network fallback is provided. A misconfigured proxy is a setup error.

```sh
cp node_modules/agent-eval-kit/examples/skill-comparison/controls.example.json ./controls.json
# Fill in the installed image digest, fixed model, auth file, internal network,
# and externally configured model-only proxy.
node node_modules/agent-eval-kit/examples/skill-comparison/run.mjs ./skill-trial ./controls.json
```

From source, use `examples/skill-comparison/` in place of the installed path.
The output directory must be new. Each run performs `2 * repetitions` live
candidate calls, at least two per variant, under the configured per-attempt wall
time budget. The adapter enforces the deadline and removes the container even on
timeout. Cleanup failures remain errors; a failed candidate cleanup stops further
model calls and records remaining attempts as unattempted. CPU (1), memory (1 GiB), process limit, fixed image, requested model,
reasoning effort, task, starting bytes, tools, and evaluator stay fixed. Only the
instruction variant changes. Use a fixed model snapshot where the provider offers
one; a requested alias alone cannot prove a fixed resolved model. Model-only
egress prevents retrieval of this public example or other solutions.
The adapter supplies no web-search tool, MCP server, host home, or Docker socket.

Each attempt receives a fresh directory with only the task, source, and ordinary
tests. Candidate containers mount that directory and their auth file only; the
experiment, AEK definitions, private grading code/expected values, run history, and
other candidates are inaccessible through the container filesystem. Do not mount
the repository or experiment root into the runner image, bake grading material
into it, or expose a host grading service. Credentials and infrastructure should
be appropriate for disposable isolated candidates.

## Evidence and interpretation

The two variants alternate order across repetitions. All attempts retain their
workspace, artifact bytes/hash, invocation, raw event stream, stderr, deadline or
execution errors, reported token usage, and wall time. Interrupted experiments
handle SIGINT/SIGTERM by stopping the active command, awaiting container cleanup,
recording the interrupted attempt, and leaving subsequent attempts unattempted.
Uncatchable process termination can leave a `started` record and requires external
container cleanup. This example provides no resume or selection algorithm and
refuses to overwrite an experiment.

After candidate execution ends, AEK snapshots the submitted module. A command
collector executes that sealed module in another container with no networking,
credentials, or grading mounts. It supplies fixed inputs and retains actual
outputs. A separate host checker verifies evidence hashes and compares with fixed
independent expected values. The artifact never runs in the host grading process.
An assertion mismatch is a product failure; invalid output, imports, crashes,
timeouts, container failures, and malformed evidence remain execution errors.
Both AEK providers are `mock` because these collection and judging paths are
deterministic; candidate model calls still use the real external runner.

`experiment.json` records fixed controls, fixture/instruction/method hashes before any
candidate runs. `journal.ndjson` records every attempt; original AEK sealed runs
stay in `runs/`. `comparisons/` contains AEK artifact comparisons for each pair
whose executions completed. `summary.json` includes outcomes, coverage, gates,
execution errors, unattempted work, per-attempt total/candidate/evaluation time,
and observed token usage. Collector cleanup and comparison-output failures also
remain errors, with their original diagnostics retained.
Monetary cost remains `null` when the subscription runner does not report it;
unknown cost is never presented as free. No scores are assigned to errors and
valid missing evidence retains reduced coverage and withheld-score semantics.

Inspect every attempt, including failures; do not select the best run. Compare
the per-variant outcome distribution and completion/coverage as well as scores.
Repeated **candidate execution** samples variability in produced artifacts.
Repeated judging of one artifact measures judging consistency only. This tiny
fixture supplies descriptive evidence and no statistical claim of superiority.
