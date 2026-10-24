# Troubleshooting

Start with the command's error and, if a run was created, its `run.log` and
`run-state.json`. Open `report.html` for completed results. Exit 1 indicates an
input or execution error; exit 2 indicates an acceptance check failed. See the
[command guide](cli.md#exit-statuses) for the full distinction.

Errors normally show the actionable message; use `--debug` for a stack trace.
Command grader errors include a bounded stderr excerpt and the full diagnostic
file paths. A checker failure is an execution error, not a product verdict.

Resume reuses unchanged inputs. After repairing checker/collector code, config,
fixtures, or the target, repeat your original run command without `--resume`.
After changing a judge configuration, start a new `judge` run against the sealed
collection. Keep the failed run for its diagnostics.

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
| `aek` is not found | Use the local package runner above, or build and globally link the source checkout as described in [installation](../README.md#from-a-source-checkout). |
| No `evalkit.yaml` in this or a parent directory | Run inside the project (AEK searches parent directories up to the Git root), pass `--config`, or create a starter with `aek init`. |
| Config file not found | The explicit `--config` path does not exist; check the path relative to the current directory. |
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
accounts/records. See [onboarding](onboarding.md) and [target lifecycle](configuration.md#target-lifecycle).

Saved-session loss detection recognizes explicit login routes and authentication
expiry query signals. Resource-creation routes such as `/admin/sessions/new` are
ambiguous and do not establish a login wall by themselves. For applications whose
login URL has no authentication signal, scenarios must verify the signed-in
identity before treating unavailable controls as missing product functionality.

Ordinary rubric judging selects screenshots from the scenarios and checkpoint
steps allowed by the requested criteria. Later captures do not displace earlier
checkpoint images. Codex receives up to 30 eligible images as attachments; larger
sets use the same restricted `view_screenshot` evidence tool as other providers.
All eligible images are available to that tool, within a call budget equal to the
selected image count and the judge's configured deadline. A successful view is
required before citing a retrieved image. Unviewed evidence remains unavailable;
this does not alter criterion requirements or award credit automatically.

## Execution failures and interrupted runs

For a scenario failure, inspect `<scenario-id>/provider-stderr.log`,
`provider-run.json`, and the browser or workspace transcript when present. For an
ordinary judge failure, inspect `areas/<area-id>/_judge/`; for command checks,
inspect `areas/<area-id>/graders/`. `run.log` identifies the failing phase.
These files can contain private evaluation data; use a
[public export](public-export.md) when sharing results.

Command graders must explicitly select `output: exit-code` or `output: json`.
JSON mode requires a successful process exit and one valid result object on
stdout; put diagnostic logging on stderr. Invalid JSON, unexpected exit codes,
signals, and timeouts are execution errors. See the
[grader contract](graders.md#command) for supported fields and exit codes.
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


## Sandboxed application previews

A sandboxed `srcdoc` preview has an opaque origin and remains excluded by default.
For an application-owned read-only preview, explicitly configure its page prefix
and iframe selector:

```yaml
browser:
  readOnlyFrames:
    - pathPrefix: /admin/communications/
      selector: iframe.email-preview-frame
```

The policy admits text and screenshot evidence only when the iframe is a direct
child of the configured application origin, its URL is `about:srcdoc`, and its
sandbox has had no permissions since attachment and has not changed. A changed
iframe must be replaced before it can be admitted again. State-preserving moves
also revoke preview eligibility, including moves of a containing shadow host.
Open and closed shadow roots created with `attachShadow` are observed from creation,
including nested roots. Roots created through other mechanisms, such as declarative
shadow DOM, remain excluded because their attachment history is unavailable.
The policy does not remove the sandbox or expose interactive
references inside the preview. Nested/unmatched/external frames remain excluded;
credential checks include approved previews, and captures are discarded if an
approved preview loses its boundary during the screenshot. Ordinary origin
allowlists remain the mechanism for interactive third-party widgets.


## Scenario deadlines and preview screenshots

A provider deadline includes its final structured response, after browser `done`.
Choose `agent.timeoutSeconds` with enough headroom for both phases. Codex timeouts
retain their timeout status and scenario diagnostics even if termination produces
exit code zero or a truncated event. Missing output without a timeout remains an
output-contract error; a completed browser call cannot substitute for finalisation.

Chromium may omit opaque iframe pixels outside the current viewport from a
full-page image even though text snapshots can read them. AEK rejects full-page
framing when an approved read-only preview's included portion is offscreen,
without saving that screenshot. Scroll the preview into view and retry with
`fullPage: false`, using multiple positions for tall previews. This framing error
is recoverable; actual evidence inspection or boundary failures remain terminal.
