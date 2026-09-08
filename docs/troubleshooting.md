# Troubleshooting

Start with the command's error and, if a run was created, its `run.log` and
`run-state.json`. Open `report.html` for completed results. Exit 1 indicates an
input or execution error; exit 2 indicates an acceptance check failed. See the
[command guide](cli.md#exit-statuses) for the full distinction.

## Setup and validation

Run these from your project root, substituting your config path if necessary:

```bash
aek validate --config evalkit.yaml
aek doctor --config evalkit.yaml
aek run --config evalkit.yaml --dry-run
```

With a local npm install, use `npx aek`; with a local pnpm install, use
`pnpm exec aek`. In the source checkout, use `pnpm aek`.

| Symptom | What to check |
| --- | --- |
| `aek` is not found | Use the local package runner above, or build and globally link the source checkout as described in the [quick start](../README.md#quick-start). |
| No config file | Run in the directory containing `evalkit.yaml`, pass `--config`, or create a starter with `aek init`. |
| Initialization refuses an existing file | Preserve the existing kit and edit it, or initialize in a new empty directory. Initialization does not overwrite files. |
| Missing environment variable | Set the named variable in the environment or `.env` beside the config. Existing environment values take precedence. |
| Missing input or invalid `methodFiles` | Check paths from `project.root`. Declare the checker and all evaluator dependencies in `methodFiles`; fixture file entries resolve from the fixture document. |
| Required provider is missing or not authenticated | Install and sign into the provider configured in `agent` or `judge`, then rerun `doctor`. Both configured providers are checked. |
| Chromium is missing | From the npm consuming project run `npx --no-install playwright install chromium`; from this checkout run `pnpm install:browser`. Workspace and direct-text scenarios do not need Chromium. |
| Native Windows is rejected | Run inside WSL with Linux Node.js, provider CLIs, and browser dependencies. Linux is the validated runtime. |
| Selection is empty or an ID is unknown | Inspect `aek list`. Check the selected suite, area/scenario IDs, and split; the default split is `development`. |

`doctor` checks local installation and login state, not remaining subscription
quota or whether a credential refresh will succeed. If a real invocation fails
after doctor passes, inspect its retained stderr and provider metadata.

## Blocked scenarios, abstentions, and withheld scores

Score and coverage answer different questions. A `cannot_judge` verdict supplies
no score; it reduces coverage. A blocked scenario cannot establish that a feature
is absent. Inspect the affected item's evidence and the scenario's `evidence.json`
to determine what was actually reached.

| Result | Next action |
| --- | --- |
| Authenticated scenario is blocked | Capture `aek auth --persona <name>` for the configured target origin. Confirm the scenario's persona and `requiresAuth` settings. Recapture an expired session. |
| Runtime criterion has only source evidence | Add an exercise and observable runtime result, or use an explicit command grader. Workspace inspection can only list, read, and search. |
| Manual checks are pending | Review `manual-checklist.md`, fill `manual-results.json`, and run `aek finalize --run <directory> --reviewer YOUR_NAME`. |
| Automatic result is `cannot_judge` | Improve evidence in a new run, or follow [adjudication](adjudication.md) when a reviewer can supply supporting evidence. |
| Headline score is withheld | Coverage is below `scoring.minimumCoverage`. Inspect blocked, abstained, and pending items and collect the missing evidence. |
| A high score still exits 2 | Inspect `gates.blocking` and the requested CI thresholds. Every critical gate requires a full pass; an unavailable gate also blocks acceptance. |
| A displayed percentage appears to meet a failed threshold | Display values are rounded; thresholds use full-precision measurements. The error includes the unrounded value. |
| Text or image example has zero coverage | Check whether it uses the offline mock judge. Mock abstentions verify wiring; select a real judge to evaluate quality. |

Application data persists independently of browser sessions. If repetitions see
different state, provide an idempotent reset in `target.setup` or isolate test
accounts/records. See [onboarding](onboarding.md) and [target lifecycle](../README.md#local-target-lifecycle).

## Execution failures and interrupted runs

For a scenario failure, inspect `<scenario-id>/provider-stderr.log`,
`provider-run.json`, and the browser or workspace transcript when present. For an
ordinary judge failure, inspect `areas/<area-id>/_judge/`; for command checks,
inspect `areas/<area-id>/graders/`. `run.log` identifies the failing phase.
These files can contain private evaluation data; use a
[public export](../README.md#public-export-and-privacy-lint) when sharing results.

Command graders must explicitly select `output: exit-code` or `output: json`.
JSON mode requires a successful process exit and one valid result object on
stdout; put diagnostic logging on stderr. Invalid JSON, unexpected exit codes,
signals, and timeouts are execution errors. See the
[grader contract](../README.md#grader-types) for supported fields and exit codes.
Malformed provider results or unsupported evidence citations also fail execution
and retain diagnostics; they are not model abstentions.

After resolving a transient problem, resume using the original mode:

```bash
aek run --resume <run-directory>
aek collect --resume <unfinished-collection-directory>
aek judge --resume <judging-directory>
```

Use one of these commands for the corresponding run. Resume verifies saved inputs
and reuses completed work. If you changed the target, evaluator, fixtures, provider
settings, or declared checker files, start a new run. A completed collection is
immutable; create a new collection for new target state.

An active run lock means another process owns the run; wait for it to finish.
AEK can recover a stale lock with a valid, dead owner PID. If the error identifies
an interrupted `.run.lock-acquisition` directory, remove that empty directory
only after confirming no process is acquiring the run, as directed by the error.

## Integrity, comparison, and promotion failures

Run `aek verify --run <directory>` to check retained artifacts. For an interrupted
report update, rerun the report update command to complete its recovery transaction.
For changed sealed evidence or a completed vote, restore the original bytes from
a trusted copy or start a new run. Editing reports or regenerating checksums would
remove the assurance that the results describe the retained evaluation.

If a comparison is incompatible, inspect its reported fingerprint differences.
Both runs must use the same evaluator: specs, fixtures, checker method files,
provider configuration/versions, and scoring settings. Change only the target
when measuring a product regression; rerun both targets with the same revised
evaluator when you change the method. `--allow-incompatible` is an explicit
exploratory override, not evidence of a comparable regression test.

A passing pilot may still be ineligible for release promotion. The default policy
requires split `all`, the complete required suite, 100% coverage, and passed gates.
Run the policy's required split, resolve missing evidence, and finalize required
reviews. Use an explicit milestone only when you intend to record an incomplete
checkpoint; see [promotion policy](evidence-workflows.md#baseline-promotion-policy).

This project is pre-release. When a version rejects old artifact formats, regenerate
runs and baselines with the current evaluator; migration compatibility is not promised.
