# Command guide

Use `aek --help` for the command overview and `aek <command> --help` (or
`aek help <command>`) for exact options, including subcommands such as
`aek help campaign compare`. `aek --version` prints the installed version. This
guide groups commands by task; see the [documentation index](README.md) for
configuration and evidence formats. With a local package installation, use
`npx aek` (npm) or `pnpm exec aek` (pnpm).

A mistyped command, subcommand, flag, YAML key, or enumerated YAML value is
rejected with the closest valid spelling, such as ``Did you mean `aek run`?``.
Terminal output is coloured when it goes to a terminal; set `NO_COLOR=1` to
disable colour or `FORCE_COLOR=1` to keep it in pipes. Long provider and judge
calls print a `… still working` line every 30 seconds.

## Install the coding-agent skills

```sh
aek skills install                 # both aek-author and aek-improve
aek skills install --agent claude  # .claude/skills for Claude Code
```

`skills install` installs both skills together and refuses to overwrite either.
`--agent claude` selects `.claude/skills`; `codex`, `cursor`, and `grok` select
`.agents/skills`. Without `--agent` or `--directory`, it uses `.claude/skills`
when the project has a `.claude/` directory and no `.agents/` directory, and
`.agents/skills` otherwise. The output names the reason for its choice.

## Guided authoring

`aek author install [--directory .agents/skills]` installs the `aek-author` skill
for your coding agent. Ask it to discover the project and interview you about
requirements. `aek author init [--project directory] [--mode project|feature]`
creates the saved map before an eval config exists; `--description` sets its scope.
`aek author status` and `aek author validate` accept `--project`, `--json`, and
`--require-ready`. They check decisions, rubric links, and recorded trial evidence;
`--require-ready` exits 2 for a valid but incomplete inventory. See [authoring](authoring.md).

## Improve an existing project

`aek improve install` installs `$aek-improve` for a bounded hypothesis/edit/evaluate
workflow. `improve start --goal text --output new-directory` creates an owned Git
worktree and baseline. Register edits with `improve attempt --session directory
--hypothesis text`, then run `improve evaluate --session directory` for full-suite
acceptance and restoration. Use `improve status` to inspect and `improve stop
--reason text` to end early. All take `--json`; see [project improvement](improvement.md)
for budgets, frozen inputs, stop reasons, artifacts, and exit statuses.

## Compare two images

```bash
aek image compare --candidate new.png --reference approved.png \
  --criterion "The labels and primary action are easy to read."
```

No config or collector setup is required. The default `non_regression` policy
accepts a win or observed equivalence; `--policy preference` requires a win.
`--absolute-criterion` adds an independent quality gate. Use `--dry-run --json`
to validate inputs without model calls, and `--output` to select a new directory.
See [image comparison](image-comparison.md) for all flags, reports, recovery,
formats, and voting semantics.

For a screenshot matrix, use `aek image batch --manifest comparisons.json
--output review-01`. It supports bounded `--concurrency`, `--resume directory`,
and strict `--reuse prior-batch`, with one HTML/JSON report for all pairs. See
[batch comparisons](image-comparison.md#batch-comparisons) for the manifest.

## Prepare and select a run

```bash
aek init --kind web
aek validate --config evalkit.yaml
aek doctor --config evalkit.yaml
aek list --config evalkit.yaml
aek run --config evalkit.yaml --dry-run
```

`init [directory]` accepts `web` (default), `repository`, `command`, `artifact`, and `visual`.
The [visual starter](visual-evaluation.md#start-a-controlled-visual-project) supplies
a runnable controlled-capture fixture and separate checks, baseline, and aspirational suites.
It writes starter files without overwriting existing files. Customize them using
the generated `evals/ONBOARDING.md` before evaluating your project.

`init` also adds `.agent-eval/` to the project's `.gitignore` (creating the file if
needed), because that directory holds retained evidence and captured browser
sessions. For web, repository, and artifact starters it probes signed-in provider
CLIs without model calls, as `aek doctor` does, and writes them into `evalkit.yaml`:
the first ready provider collects, and a different ready provider judges when one is
available. `--agent` and `--judge` choose explicitly. The command starter uses
offline mock providers and needs no scenario; the visual starter keeps its own
calibrated providers.

`validate` checks configuration, specs, and declared input files. `doctor` checks
local tooling and saved provider login without model calls. `list` shows the
suite's definitions. `run --dry-run` validates the selected execution without
starting a target or provider or creating a run directory; add `--json` for a
machine-readable execution plan. See [configuration fields](configuration.md)
for all YAML defaults and limits. These checks do not establish product quality.

Without `--config`, commands use the nearest `evalkit.yaml` in the current
directory or a parent directory, stopping at the enclosing Git repository root,
and print `Using <path>` when it came from a parent. Paths in the configuration
resolve from `project.root`, which resolves from the config file. Commands
accepting `--config` also accept `--suite name` for configured named suites.

## Develop a command checker

```sh
aek check                 # every applicable standalone command checker
aek check CORE-01         # one rubric item; area/ID also works
```

`aek check` executes command graders exactly as a run would (same command,
working directory, timeout, and output contract) without creating a run, sealing
inputs, or retaining output. It prints each verdict with its reasoning, or the
checker error with the end of its stderr. Exit status is 0 when every checker
passes, 2 when any reports another verdict, and 1 for a checker execution error.
Declared inapplicable criteria are skipped by default; selecting one explicitly
fails with its exclusion reason. Selectors must be exactly `ID` or `area/ID`;
empty or extra path components fail before any checker executes.
Graders that read scenario evidence (`scenarios:` listed) or run with `cwd: run`
need a real run and are rejected with the command to use. `AEK_RUN_DIR` points
to a temporary directory that is discarded, and `AEK_CHECK=1` is set. Use
`aek run` for evidence, scores, and comparisons. See the
[checker helpers](graders.md#checker-helpers) for emitting verdict JSON.

## Refer to runs

`--run`, `--baseline`, `--candidate`, `--resume`, `--evidence`, and
`--changed-since` accept a run directory, a run ID from `paths.runs` (the directory
name, such as `2026-10-24T04-06-57`), `latest`, or `previous`. Aliases resolve
among the runs the command can use: complete runs with a report for `compare`,
`finalize`, `rescore`, `adjudicate`, `export`, and promotion; complete collections
for `judge --evidence`; and incomplete runs of the matching mode for `--resume`.
`previous` is the second-newest such run. Run IDs and aliases use the nearest (or
`--config`) configuration to find `paths.runs`.

```sh
aek compare --baseline previous --candidate latest --fail-on-regression
aek finalize --run latest --interactive
```

After each scored run, the command prints the run directory and the next
commands with real paths: `finalize` when manual reviews are pending, and
`compare` against the previous complete run.

## Review run history

```sh
aek runs list               # newest 20 runs, with score change and trend
aek runs list --limit 50 --json
aek runs prune --keep 10 --dry-run
aek runs prune --older-than 30
```

`runs list` shows each run's status, score, score change (Δ), coverage, critical
gates, pending manual reviews, and the first line of any failure. Δ compares a
report with the previous listed report only when their evaluator fingerprints
match; otherwise it shows `evaluator changed`. A sparkline summarizes the score
trend of reports whose scores are not withheld.

`runs prune` deletes run directories beneath `paths.runs`: `--keep n` keeps the
newest n runs, and `--older-than days` deletes only runs started earlier than
that. With both, a run must satisfy both to be deleted. It skips runs with a live
owner, any existing run lock (including stale or unreadable locks), or a lock
acquisition in progress. Resolve interrupted ownership before removing a stale
lock; detached workers may outlive their parent process. Deletion reserves the
run against concurrent resume and review commands. Promoted baselines are separate
snapshots and are unaffected; comparisons stored inside a deleted run are deleted
with it. Use `--dry-run` first.

| Run flag | Meaning |
| --- | --- |
| `--areas checkout,account` | Select area IDs. |
| `--scenarios CART-S1,CART-S2` | Select scenario IDs; dependencies still apply. |
| `--include-optional` | Include optional areas. |
| `--split development\|evaluation\|all` | Select cases; default is `development`. Unsplit cases are shared. |
| `--url https://preview.example.test` | Override the web target URL. |
| `--agent codex --judge claude` | Select collection and judging providers independently. |
| `--agent-model id --judge-model id` | Override provider-specific model settings. |
| `--max-turns 20` | Bound scenario provider turns, or MCP tool calls for Codex. |
| `--headed` | Show the browser during browser execution. |
| `--fail-under-score 85 --fail-under-coverage 90` | Add percentage thresholds to critical gates. |

Direct text evaluation also supports `--text-cases area/dataset/case,...` or
`--changed-since <prior-run-directory>`. See [text selection](text-evaluation.md)
for restrictions and coverage semantics. Unknown flags and unexpected positional
arguments fail; boolean flags such as `--headed` take no value.

## Structured results

`run`, `check`, `collect`, `judge`, `judge validate`, `campaign`, `campaign compare`, `compare`,
`validate`, `list`, `doctor`, `verify`, `rescore`, `finalize`, `adjudicate`, `runs list`,
`runs prune`, `skills install`, and all `improve` subcommands accept `--json`. Actual execution writes one version-1 JSON envelope to stdout; progress
and diagnostics go to stderr. Exit statuses keep their ordinary meanings.

```sh
aek run --json > result.json
aek compare --baseline previous --candidate latest --json
```

The envelope contains `version`, `command`, `status`, `exitCode`, and `result`.
Status is `completed`, `acceptance_failed`, `error`, or `interrupted`.
A scored result includes `runId`, `runDir`, `execution`, `scorePct`, `coveragePct`,
`scoreWithheld`, `provisionalScorePct`, `gates`, `manualPending`, `items`,
`acceptanceFailures`, and `artifacts.report` / `artifacts.html`. `items` lists every
judged or pending criterion with `areaId`, `itemId`, `verdict` (null while a manual
review is pending), `confidence`, `source`, `gate` (`passed`, `failed`,
`unavailable`, or null), `unproven`, `manualPending`, and `reasoning`. When coverage withholds the score,
`scorePct` is null and only `provisionalScorePct` contains the score over judged
evidence. A successful collection supplies its manifest path and no score.

Acceptance failure retains the completed result and its artifact paths. A thrown
input/execution error supplies `error.message` and a null result. If execution
created a run or campaign, `context` identifies its directory; partial artifacts
are diagnostic evidence, not a completed evaluation. Commands such as campaign
and judge validation can return an error status with a result describing retained
failed attempts. Interruptions exit 130/143 and retain the same distinction.

`--resume --json` is supported; specify the saved directory as usual. Campaign
resume also permits `--debug`, while execution options still come from its journal.
`--dry-run --json` continues to return the version-2 execution plan directly.
Failed JSON commands, including previews, return the version-1 error envelope.
Image, authoring, and authentication commands retain their documented JSON formats.

Expected errors show concise messages. Add `--debug` to include stack traces on
stderr, including when stdout is JSON. Schema errors identify the nearest YAML
source node with a file, line, column, and field path. Validation establishes input
contracts and referenced files; it does not execute checkers or prove evaluation quality.

## Execution previews

`run`, `collect`, and `campaign` accept `--dry-run`, with optional `--json`.
Previews validate the selected inputs without starting services, running evaluator
commands, making model calls, or creating output directories. `--changed-since`
also checks local provider versions to compare the prior evaluation method; ordinary
previews need no provider installation.
`--resume` cannot be combined with a preview.

The version-2 JSON object contains:

| Field | Meaning |
| --- | --- |
| `version`, `mode`, `project`, `suite`, `split`, `repetitions` | Plan identity and repetition count. |
| `target` | Target kind/URL, setup/start commands, readiness, external-server policy. Environment names are shown without their values. |
| `services` | Required Chromium, provider roles/purposes, saved personas, and email-auth personas. `version-only` providers are needed for provenance even when no model calls are planned; `browser.collectionPlanned` distinguishes capture from a version probe. Custom command services cannot be inferred. |
| `executionOrder` | Per-repetition collector and grading phases, with prerequisites before dependents. |
| `areas[].scenarios` | Selected collectors, dependencies, bindings, required checkpoints, authentication, command/capture settings, declared image/file outputs, and any blockage known from filtering. |
| `areas[].skippedScenarios` | Scenarios omitted by selection or not reached from scored areas. |
| `areas[].graders` | All applicable graders, weights, gates, commands/method files, manual/deferred status, and text-case selection. |
| `areas[].exclusions` | Declared out-of-scope criteria and reasons. |
| `areas[].judgeGroups` | Per-repetition invocation ranges; ordinary rubric items share an area judge call. |
| `judgeCalls` | Total and per-repetition conditional minimum/maximum judge invocations. |

The ranges assume a fresh run with every required observation available. Image
comparisons multiply scenarios by references; text comparisons multiply selected
cases by references; ordinary repeated judges batch their area's criteria. Campaign
ranges multiply by repetitions. Adaptive voting selects a count within the range;
blocked scenarios, missing evidence, or execution failures can reduce it below the
conditional minimum. These are invocation counts, not token, price, or duration
estimates. Mock invocations use no model quota.

Scenario filtering does not automatically include filtered prerequisites: the plan
marks their selected dependents `blocked-by-selection`. Include prerequisites in
`--scenarios` to exercise the workflow. Runtime authentication, readiness, and
product outcomes remain unknown until execution. Unselected text cases remain in
the plan and reduce coverage; their previous judgments are not reused.

`collect` plans command checks but defers scoring/model/manual graders until judging.
Campaign plans describe the same execution repeated sequentially. The separate
`aek image compare --dry-run --json` command keeps its image-specific preview format.

## Execute, recover, and review

Each `<run>` below accepts a directory, run ID, `latest`, or `previous`
(see [refer to runs](#refer-to-runs)).

| Command | Effect |
| --- | --- |
| `aek run` | Collect evidence, execute graders, and write reports. |
| `aek run --resume latest` | Reuse completed work from the newest incomplete run when the original inputs still match. |
| `aek collect` | Execute collection and command checks, then seal evidence without a model judge or score. |
| `aek collect --resume <collection-directory>` | Recover an unfinished collection. |
| `aek judge --evidence <collection-directory>` | Create a new scored run from sealed evidence. |
| `aek judge --resume <judging-directory>` | Recover an interrupted judging run. |
| `aek judge validate --dataset cases.json --labels labels.json --configurations configurations.json --output new-directory` | Compare configurations with reviewed evidence labels; retain JSON and HTML reports. |
| `aek verify --run <run>` | Check retained artifact integrity. |
| `aek rescore --run <run>` | Apply permitted scoring changes to a completed run without another provider call. |
| `aek finalize --run <run> --interactive` | Prompt for each pending manual verdict and notes, then record review history. |
| `aek finalize --run <run> --reviewer YOUR_NAME` | Apply edits from `manual-results.json` and record review history. |
| `aek adjudicate --run <run> --input decisions.json --reviewer YOUR_NAME` | Resolve eligible automatic abstentions using explicit human evidence. |

Use the resume command matching the original run mode. Changed target inputs
require a new run; changed judging criteria over reusable evidence require a new
`judge` run. `rescore` reuses existing verdicts and cannot evaluate a new criterion.
See [run recovery and review](runs.md#resume-an-interrupted-run),
[collect/judge compatibility](evidence-workflows.md), and
[adjudication input format](adjudication.md).

For browser sessions, use `aek auth --persona buyer --at /login`, complete the
login, then press Enter. `--email` uses a declared email authentication flow.
See [authentication](authentication.md) and [email](email.md).

## Compare, promote, and share

| Command | Purpose |
| --- | --- |
| `aek compare --baseline <good-run> --candidate <new-run> --fail-on-regression` | Compare compatible completed runs and fail on regressions. |
| `aek campaign --repetitions 5` | Execute the same evaluation sequentially and report stability. |
| `aek campaign --resume <campaign-directory>` | Continue unstarted repetitions using verified original options and results. |
| `aek campaign compare --baseline <old-campaign> --candidate <new-campaign>` | Compare repeated-run results. |
| `aek benchmark experiment --recipe <recipe.json> --output <new-directory>` | Interleave multiple benchmark candidates in explicit blocks under a shared resource lock. |
| `aek baseline promote --run <run> --name main --reviewer YOUR_NAME` | Save an immutable baseline under the configured promotion policy. |
| `aek baseline list` | List promoted baselines. |
| `aek compare --baseline-name main --candidate <new-run>` | Compare against a promoted baseline. |
| `aek reference promote --run <run> --name voice --reviewer YOUR_NAME` | Promote snapshotted text candidates for use as text references. |
| `aek reference list` | List promoted text references. |
| `aek export --public --run <run>` | Create an integrity-verified, privacy-linted minimal export. |
| `aek privacy lint --path <file-or-directory>` | Check proposed output for likely private data. |

`compare` also accepts `--max-score-drop` and `--max-coverage-drop` in percentage
points. Incompatible evaluations produce an audit report with numeric deltas
withheld and exit 2. `--allow-incompatible` records an exploratory override.
`comparison.html` supports a filtered review of reasoning, critical gates, and
retained evidence; retain the source runs alongside the report. See
[comparing runs](comparisons.md#compare-runs), [campaigns](comparisons.md#repeated-run-campaigns),
and [public export](public-export.md).

`aek judge validate` has a separate [reviewed-label workflow](judge-validation.md):
it writes `validation-results.json` and `validation-results.html`, requires a new
output directory, and exits 1 for invalid input or execution errors. Reviewer
disagreement does not cause acceptance failure; product compatibility, score
thresholds, and critical gates are not validation acceptance rules. SIGINT and
SIGTERM retain partial reports and exit 130/143.

Release baseline promotion defaults to the complete required suite, split `all`,
100% coverage, and passed gates. A normal `development` run does not meet that
split requirement. See [promotion policy](evidence-workflows.md#baseline-promotion-policy)
before promoting. Promoting a text reference is a separate workflow from accepting
a scored release baseline.

## Controlled benchmark experiments

```sh
aek benchmark experiment \
  --recipe evals/benchmark.json \
  --output .agent-eval/experiments/trial-1
```

Use `run` for one evaluation, `campaign` to repeat one configuration, and
`benchmark experiment` to compare multiple prepared candidates with an explicit
visit order. The JSON recipe declares candidate configs, the baseline, blocks,
shared resource directory, per-visit timeout, and measurement selection. See the
[benchmark guide](../examples/benchmark/README.md) for the recipe and workload contracts.

Both `--recipe` and `--output` are required. Candidate config and resource paths
resolve relative to the recipe file; output resolves from the working directory.
The final output directory must be new. The command reports preparation and each
visit's block, candidate and status to stderr, then prints the outcome, visit
counts and paths to `experiment.html` and `summary.json` to stdout.

Exit codes are 0 for compared, 2 for requirement failure or inconclusive evidence,
and 1 for input/execution errors. `compared` does not establish statistical
confidence or automatic performance acceptance. SIGINT/SIGTERM stop acquisition,
retain failed and unattempted visits, await cleanup and exit 130/143. After a
parent crash, the resource lock requires manual recovery as described in the
benchmark guide. Interrupted experiments are retained and cannot be resumed.

## Campaign recovery

```sh
aek campaign --repetitions 5 --split all --fail-under-score 85 --fail-under-coverage 90
# If interrupted, use the campaign directory printed at startup:
aek campaign --resume /path/to/campaign
```

Campaigns save checksummed `campaign-state.json` before each attempt and after
recording its outcome. Recovery restores the config path, suite/provider overrides,
area/scenario/split selection, repetition count, and acceptance thresholds. Supply
`--resume` with optional `--json` / `--debug`; changing execution options requires a new campaign.

Completed and failed attempts retain their original ordinal and evidence. Resume
starts only repetitions that never started; it does not retry a failed attempt or
replace it with a success. An interrupted attempt counts as failed. A run that
finished and sealed its report just before campaign publication stopped is recovered
as complete after integrity verification. Completed campaigns can be reopened
without executing more repetitions; retained failures still produce exit 1.

Recovery requires unchanged target/evaluator/fixture/provider inputs relative to
the last checkpoint, or target changes already sealed in the interrupted attempt's
intact receipt. Later target edits are rejected. Evaluator and candidate source
inputs must remain fixed throughout the campaign; a checker that changes them
stops the campaign with a retained checkpoint error. Recovery verifies completed reports against their recorded artifact
roots, and verifies retained indexed evidence for failed attempts. Changed or
corrupt evidence fails before more work starts. A campaign lock rejects concurrent
resumes. Missing run state alongside execution artifacts, or a missing active run
directory, requires restoration before recovery can proceed; the journal stays
unchanged. Interruptions before run-state initialization can still be recorded as
failed attempts when only initialization files remain (input snapshots, lock files,
or a temporary first state write). The same stale-owner rules as run locks apply.
Do not resume while orphaned processes from a forcibly killed evaluation are still running.

Before checkpointing a failed attempt, the campaign verifies previously indexed
evidence and records a separate snapshot in `failed-artifacts/<ordinal>.json` within
the campaign directory. A refreshed receipt must match the current inputs and run
state. Managed-server logs may grow only by appending to their previously indexed
bytes; edits to those bytes or to completed evidence fail. Interrupted report
rewrites remain diagnostic data. The original run index stays unchanged, so these
reports do not become trusted results for ordinary run recovery. A campaign resume
verifies its separate snapshot, including the original run index. `aek verify --run`
still checks the run's execution index and may report unfinished writes in that
failed run.

The state journal is authoritative; interrupted `campaign.json`/HTML publication
is rebuilt from it. Keep the campaign directory, source run directories, config,
and evaluation inputs. Campaigns created without a recovery journal cannot resume;
start a new campaign. Lifecycle preparation still runs once per new repetition,
and application/database reset remains project-owned.

## Exit statuses

| Status | Meaning and action |
| --- | --- |
| `0` | The command completed and its applicable checks passed. Inspect score and coverage to understand what was established. |
| `1` | Invalid input, missing required tooling, or execution/contract/integrity failure. Repair the reported error. |
| `2` | An acceptance check failed: a critical gate, requested threshold, comparison check, promotion policy, or privacy lint. Review the reported findings. |
| `130` / `143` | Execution was interrupted by SIGINT / SIGTERM. Use the matching resume command after resolving the interruption. |

A rubric `fail` does not by itself make `run` exit 2 unless it blocks a critical
gate or requested threshold. Low coverage can withhold the headline score without
failing the command when no applicable gate or CLI threshold requires it.
For CI, set both `--fail-under-score` and `--fail-under-coverage`; critical gates
are enforced independently. These thresholds also work with `judge`, `rescore`,
`finalize`, and `adjudicate`, and on campaign repetitions.

Scored-run and comparison acceptance failures write reports before exiting 2.
An execution failure may leave only partial artifacts. Successful `collect` or
`verify` establishes collection completion or integrity, respectively, rather
than a passing quality score. See [troubleshooting](troubleshooting.md).
