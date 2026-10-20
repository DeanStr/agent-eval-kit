# Project-owned benchmarks

For measurements sensitive to visit order or shared hardware, use the controlled
experiment runner:

```sh
node examples/benchmark/experiment.mjs /tmp/new-experiment recipe.json
```

```json
{
  "version": 1,
  "candidates": {"baseline": "before/evalkit.yaml", "candidate": "after/evalkit.yaml"},
  "baseline": "baseline",
  "blocks": [["baseline", "candidate"], ["candidate", "baseline"]],
  "resource": "/path/to/shared-resource/gpu",
  "timeoutSeconds": 1800,
  "measurement": {"scenarioId": "WORKLOAD", "fileLabel": "measurements"}
}
```

Config and resource paths resolve relative to the recipe. Every block visits
each named candidate exactly once; two or more blocks are required. Acquisition
is serial. All experiments using the same resource directory share the existing
AEK process lock, across projects and output directories. The lock remains held
until active subprocess cleanup finishes. It coordinates participating AEK
experiments; it cannot exclude unrelated host activity.

The public `agent-eval-kit/benchmark/experiment` export provides
`runBenchmarkExperiment(output, recipe, {baseDirectory, signal})`, the recipe
schema, and `counterbalancedBlocks(candidateIds, repetitions)`. Library callers
own signal handling. The packaged entry point forwards SIGINT/SIGTERM through
AEK's existing cancellation machinery.

Each preparation and visit loads its config in a fresh process, with the caller's
original environment and that project's own `.env`. Candidate dotenv values never
modify the caller or another candidate. Original managed AEK artifact directories
stay excluded when runs are relocated to the experiment output. Failed preflight
leaves the requested output path available for a corrected retry.

`counterbalancedBlocks` alternates forward/reverse order. With three or more
candidates, reversal alone does not rotate every candidate through every position:
the middle candidate can remain in the middle. Supply explicit rotated blocks
when position balancing is required by the application protocol.

Each visit is an ordinary AEK run with its normal source/evaluator snapshots,
collection, gates and integrity checks. Candidate inputs must remain fixed,
including across setup/start commands. Build targets before the experiment; reset
or seed work must leave authenticated target inputs unchanged. A changed target is
an execution error rather than a refreshed baseline for later visits.
An execution error stops later acquisition and retains the failed and unattempted
visits. A correctness failure remains a failed gate even if the candidate is
faster. Output includes the acquisition ledger, per-candidate campaigns, ordinary
benchmark comparisons and descriptive differences paired by block. An interrupted
experiment is retained, not automatically resumed or pooled into a new run.
Ordering reduces one source of drift; neither this schedule nor two repetitions
establish statistical confidence or performance acceptance.

The older runner below uses sequential whole campaigns and is suitable only when
that acquisition order is an intentional part of the application protocol.

Build candidates before measurement. Keep workload scripts, data, reset logic,
instrumentation and correctness/performance acceptance criteria in the application
repo. An ordinary command collector invokes the project's measurement script and
retains its raw output; command graders independently check correctness. Candidate
instruction execution remains outside AEK scenarios.

Use the same evaluator files and source declaration paths in two prepared project
roots. Candidate code or selection manifests belong in `collect.sources`, not
`methodFiles`, grader commands, evaluator variables, or instructions. Declare
instrumentation, workload/data definitions and checkers as method files. A candidate
change must change target/input identity while preserving evaluator identity.

```sh
pnpm build # source checkout only
node examples/benchmark/run.mjs /tmp/new-benchmark /path/to/app/evals/recipe.json
```

[recipe.example.json](recipe.example.json) names the two project configs, fresh
repetition count, campaign timeout, and measurement scenario/file label. Config
paths resolve relative to the recipe. Use an output directory outside either
project root, or inside its AEK-excluded `.agent-eval` tree. Measurement scripts
must write into `AEK_COLLECT_CONTEXT.outputDir`; target/source mutation during a
campaign is an execution error. Use `target.setup` for explicit reset/seed work.
The recipe uses existing sequential campaigns and their cleanup/cancellation,
then reads sealed evidence. It retains both campaigns and every command log.
Execution errors stop later campaigns; the summary identifies unattempted sides.
Inspect outcome distributions, pending/failed repetitions, and host activity;
this sequential recipe does not remove thermal/order drift or establish a
statistical claim. Project-owned paired/block protocols may be run separately.

The collector declares files such as `files: [measurements, raw]` and returns
them using the existing collection manifest. `measurements` is JSON conforming
to `benchmarkMeasurementsSchema` from `agent-eval-kit/benchmark`:

```json
{
  "version": 1,
  "candidate": { "id": "worker-pool", "revision": "implementation-content-hash" },
  "workload": { "id": "fixed-inputs-v1", "sha256": "<64 lowercase hex characters>" },
  "method": { "id": "browser-timer-v1", "sha256": "<64 lowercase hex characters>" },
  "environment": { "runtime": "pinned-version", "hardware": "machine-id", "concurrency": 1, "cache": "warm" },
  "work": { "unit": "items", "requested": 20, "completed": 20 },
  "outcome": { "state": "completed" },
  "metrics": [{
    "id": "processing", "unit": "ms", "preferredDirection": "lower",
    "scope": "application", "observation": { "state": "observed", "samples": [41.2, 42.1] }
  }],
  "correctness": [{ "scenarioId": "WORKLOAD", "fileLabel": "raw" }]
}
```

Use real content hashes for workload/data and measurement implementation. Retain
raw samples and correctness inputs as declared files; the schema is metadata,
not an independent verifier of project instrumentation claims. Correctness file
references are resolved and hash-verified against the sealed run. Declare at
least one project correctness gate citing a declared correctness file;
absent/unavailable gates or missing file citations make the outcome
inconclusive. A faster candidate that fails correctness remains a requirement failure.

The project declares all relevant environment settings, including actual browser,
GPU/driver, hardware, service region, resolution, concurrency, cache/warmup policy,
seeds, and resource limits where applicable. These fields must match exactly;
AEK also checks collection Node/platform/architecture. Different candidate
identities are allowed across sides and must stay fixed within each campaign.
Workload/method identity, requested-work counts/units, metric ids/units/directions,
timing scopes, and evaluator identity must match. There is no compatibility override.

`scope` is `application`, `remote_execution`, or `evaluation`. Take application
timings at the project's application boundary. Retain transport/remote startup
overhead separately; never substitute AEK duration or subtract an estimated
overhead to invent application time. AEK duration is reported separately and
includes collection and judging. Units and direction (`lower`/`higher`) describe
measurements, not automatic acceptance thresholds.

Use `{ "state": "unavailable", "reason": "..." }` instead of an observation
with samples when a metric cannot be measured. A blocked workload uses
`outcome: {state: blocked, reason: ...}` and retains its completed-work count.
A command collector can return `blocked` without a measurement file. Missing
declared evidence from a completed collection, malformed measurements, crashes,
and timeouts are execution errors. No zero measurement or product score is
substituted. Incompatible inputs or partial/blocked/missing repetitions withhold
aggregate comparison measurements; every original observation remains available.

`benchmark-comparison.json` retains every attempt, raw samples, work counts,
identities, correctness evidence receipts and gates. Its HTML shows baseline and
candidate means, absolute/relative changes, timing scope, correctness state and
execution diagnostics together. Means give each run equal weight; within-run
samples are not independent repetitions. A zero baseline has no relative change.
Exit codes: 0 compared, 2 requirement failure/inconclusive, 1 execution error.

Existing campaigns can be compared offline without rerunning workloads or graders:

```js
import { compareBenchmarkCampaigns, writeBenchmarkComparison } from "agent-eval-kit/benchmark";
const report = compareBenchmarkCampaigns(before, after, { scenarioId: "WORKLOAD", fileLabel: "measurements" });
writeBenchmarkComparison(output, report);
```

See [consumer validation](../../docs/workflow-consumers.md) for Melbourne's actual
portable-hash workload and the limits of that validation.
