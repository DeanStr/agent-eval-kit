# Command guide

Use `aek --help` to inspect the installed CLI. This guide groups commands by task;
see the [documentation index](README.md) for configuration and evidence formats.
With a local package installation, use `npx aek` (npm) or `pnpm exec aek` (pnpm).

## Guided authoring

`aek author install [--directory .agents/skills]` installs the `aek-author` skill
for your coding agent. Ask it to discover the project and interview you about
requirements. `aek author init [--project directory] [--mode project|feature]`
creates the saved map before an eval config exists; `--description` sets its scope.
`aek author status` and `aek author validate` accept `--project`, `--json`, and
`--require-ready`. They check decisions, rubric links, and recorded trial evidence;
`--require-ready` exits 2 for a valid but incomplete inventory. See [authoring](authoring.md).

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

## Prepare and select a run

```bash
aek init --kind web
aek validate --config evalkit.yaml
aek doctor --config evalkit.yaml
aek list --config evalkit.yaml
aek run --config evalkit.yaml --dry-run
```

`init [directory]` accepts `web` (default), `repository`, `command`, and `artifact`.
It writes starter files without overwriting existing files. Customize them using
the generated `evals/ONBOARDING.md` before evaluating your project.

`validate` checks configuration, specs, and declared input files. `doctor` checks
local tooling and saved provider login without model calls. `list` shows the
suite's definitions. `run --dry-run` validates the selected execution without
starting a target or provider or creating a run directory; add `--json` for a
machine-readable scenario plan. These checks do not establish product quality.

New project runs default to `evalkit.yaml` in the current directory. Paths in the
configuration resolve from `project.root`, which resolves from the config file.
Commands accepting `--config` also accept `--suite name` for configured named suites.

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

## Execute, recover, and review

Replace the directory placeholders below with the paths printed by your commands.

| Command | Effect |
| --- | --- |
| `aek run` | Collect evidence, execute graders, and write reports. |
| `aek run --resume <run-directory>` | Reuse completed work when the original inputs still match. |
| `aek collect` | Execute collection and command checks, then seal evidence without a model judge or score. |
| `aek collect --resume <collection-directory>` | Recover an unfinished collection. |
| `aek judge --evidence <collection-directory>` | Create a new scored run from sealed evidence. |
| `aek judge --resume <judging-directory>` | Recover an interrupted judging run. |
| `aek verify --run <run-directory>` | Check retained artifact integrity. |
| `aek rescore --run <run-directory>` | Apply permitted scoring changes to a completed run without another provider call. |
| `aek finalize --run <run-directory> --reviewer YOUR_NAME` | Apply edits from `manual-results.json` and record review history. |
| `aek adjudicate --run <run-directory> --input decisions.json --reviewer YOUR_NAME` | Resolve eligible automatic abstentions using explicit human evidence. |

Use the resume command matching the original run mode. Changed target inputs
require a new run; changed judging criteria over reusable evidence require a new
`judge` run. `rescore` reuses existing verdicts and cannot evaluate a new criterion.
See [recovery](../README.md#run-resume-rescore-finalize),
[collect/judge compatibility](evidence-workflows.md), and
[adjudication input format](adjudication.md).

For browser sessions, use `aek auth --persona buyer --at /login`, complete the
login, then press Enter. `--email` uses a declared email authentication flow.
See [authentication](../README.md#authentication) and [email](email.md).

## Compare, promote, and share

| Command | Purpose |
| --- | --- |
| `aek compare --baseline <good-run> --candidate <new-run> --fail-on-regression` | Compare compatible completed runs and fail on regressions. |
| `aek campaign --repetitions 5` | Execute the same evaluation sequentially and report stability. |
| `aek campaign compare --baseline <old-campaign> --candidate <new-campaign>` | Compare repeated-run results. |
| `aek baseline promote --run <run-directory> --name main --reviewer YOUR_NAME` | Save an immutable baseline under the configured promotion policy. |
| `aek baseline list` | List promoted baselines. |
| `aek compare --baseline-name main --candidate <new-run>` | Compare against a promoted baseline. |
| `aek reference promote --run <run-directory> --name voice --reviewer YOUR_NAME` | Promote snapshotted text candidates for use as text references. |
| `aek reference list` | List promoted text references. |
| `aek export --public --run <run-directory>` | Create an integrity-verified, privacy-linted minimal export. |
| `aek privacy lint --path <file-or-directory>` | Check proposed output for likely private data. |

`compare` also accepts `--max-score-drop` and `--max-coverage-drop` in percentage
points. Incompatible evaluations produce an audit report with numeric deltas
withheld and exit 2. `--allow-incompatible` records an exploratory override.

Release baseline promotion defaults to the complete required suite, split `all`,
100% coverage, and passed gates. A normal `development` run does not meet that
split requirement. See [promotion policy](evidence-workflows.md#baseline-promotion-policy)
before promoting. Promoting a text reference is a separate workflow from accepting
a scored release baseline.

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
