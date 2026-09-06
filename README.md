# Agent Eval Kit (`aek`)

`aek` is a configurable, evidence-first evaluation harness for any software project. It runs test scenarios with the coding-agent subscription you already pay for—OpenAI Codex, Claude Code, or Grok Build—then uses a fresh agent context plus deterministic checks to score a weighted rubric.

No provider SDK and no API key are required. 

This is an early pre-release project. Backward compatibility is not a requirement: configuration, artifact formats, and APIs may change without migration support. Regenerate affected runs and baselines after such changes.

It supports:

- deployed web apps and local web apps (managed setup/start/readiness);
- repositories and command-line projects;
- black-box browser scenarios through a shared Playwright MCP server and path-contained repository inspection through a read-only workspace MCP server;
- deterministic command graders, independent LLM judges, manual graders, true weighted hybrid graders, and critical pass/fail gates;
- controlled visual capture, independent motion/repeatability tolerances, image-health and scoped distinctness checks, opt-in image-statistic baseline gates, blind pairwise image graders, and resumable repeated judging;
- direct text comparisons for writing style and taste, with anonymous A/B votes, optional target voice, and verified passage citations;
- command collectors for exported artifacts with snapshotted sources, validated image manifests, and extraction provenance; named capture checkpoints for irregular temporal sampling;
- incremental artifacts, fingerprint-checked resume, reproducibility receipts, tamper-evident output indexes, offline rescore, auditable manual finalization, coverage thresholds, and diagnostic tags;
- parameterized case matrices, diagnostic strata, and fingerprinted development/evaluation splits;
- repeated-run campaigns with rubric/case/stratum stability, whole-run bootstrap intervals, and paired case-level campaign comparisons;
- compatibility-checked comparisons and append-only promoted baseline snapshots;
- minimal public exports with an automatic privacy lint that never echoes matched secret values;
- interchangeable agent and judge providers, so you can use Codex to test and Claude or Grok to judge.

## Why this design

The score and the evidence coverage are separate. `cannot_judge` never becomes a zero, and a negative verdict is discarded when every scenario behind it was blocked before it could look. A high score over thin evidence is withheld below the configured coverage threshold.

The evaluator and judge are also separate runs. The judge sees collected evidence, not the scenario agent's private reasoning, which reduces self-confirmation bias.

Explicitly source-level criteria may be judged from inspected code and concrete static counterexamples. Runtime, integration, and persistence criteria still require evidence that the behavior was exercised; source inspection alone cannot establish those claims.

```text
evalkit.yaml + specs + fixtures
               │
               ├── scenario agent (Codex / Claude / Grok subscription)
               │      ├── browser MCP evidence, or read-only workspace inspection
               │      └── screenshots, observations, transcript, provider events
               │
               ├── deterministic command graders
               └── fresh structured-output judge
                         │
                         └── report.json + report.html + manual checklist
```

## Requirements

- Linux is the validated runtime. Native Windows evaluation is unsupported and fails before launch. On Windows, run inside WSL using Linux Node.js, provider CLIs, and browser dependencies—not Windows executables through WSL interop. macOS is not yet CI-certified.
- Node.js 20.12+
- pnpm (or npm)
- at least one supported CLI, already signed into a subscription
- Playwright Chromium for browser scenarios (`pnpm exec playwright install chromium`)

```bash
# Codex: choose “Sign in with ChatGPT”
codex

# Claude Code: use a Pro, Max, Team, or Enterprise account
claude

# Grok Build: browser login; device auth is also available
grok login
```

Verify the machine without spending model quota:

```bash
pnpm aek doctor
```

When `evalkit.yaml` is present, `doctor` requires only its configured providers
and requires Chromium only if a browser scenario is defined. Outside a configured
project it probes all providers, succeeds when at least one is ready, and reports
Chromium as optional. Use `--config file` or `--providers codex,claude` to check an
explicit setup.

The adapter contracts follow the official automation surfaces: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), and [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting).

## Quick start

New to AEK? Start with [your first evaluation](docs/first-run.md): run a small offline example, learn to read score, coverage, and gates, then introduce and compare a deliberate defect.

From this repository:

```bash
pnpm install
pnpm install:browser
pnpm build
pnpm link --global

cd /path/to/your/project
aek init --kind web
```

Choose `--kind web`, `repository`, `command`, or `artifact` (default: `web`).
Initialization writes an editable starter, not a discovered evaluation of your project.
Follow the generated `evals/ONBOARDING.md` to define one measurable requirement,
prepare test state, and calibrate it on known-good and deliberately broken behavior.
See [onboarding your project](docs/onboarding.md) for the complete workflow.

Edit `evalkit.yaml`, `evals/specs/core.yaml`, and `evals/fixtures.yaml`, then:

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

`aek init` includes an onboarding guide and, for command/artifact starters, a checker or collector script. It stages the complete starter kit and publishes it without overwriting existing files. It preflights every destination and rolls back files it published if initialization fails, so a conflict cannot leave a half-created kit.

## Configuration

`evalkit.yaml` is deliberately project-owned:

```yaml
version: 1
project:
  name: Acme Store
  root: .

target:
  kind: web                    # web | repository | command
  url: http://127.0.0.1:3000
  allowedOrigins:
    - http://127.0.0.1:3000
    # Wildcards are opt-in: https://*.acme.test
  setup:
    command: pnpm install --frozen-lockfile
    timeoutSeconds: 600
  start:
    command: pnpm dev
    env: { NODE_ENV: test }
  ready:
    url: http://127.0.0.1:3000/health
    timeoutSeconds: 120
    intervalMs: 500

agent:
  provider: codex
  model: gpt-5.6-sol           # optional; omit to use the CLI default
  effort: high
  maxTurns: 60 # Claude/Grok provider turns; Codex MCP interactions
  timeoutSeconds: 1800
  extraArgs: []

judge:
  provider: claude
  model: opus                  # optional provider-specific id or alias
  effort: high
  timeoutSeconds: 900

paths:
  specs: evals/specs
  fixtures: evals/fixtures.yaml
  runs: .agent-eval/runs
  auth: .agent-eval/auth
  baselines: evals/baselines     # compact promoted snapshots; safe to review and commit

browser:
  headless: true
  viewport: { width: 1280, height: 800 }
  actionTimeoutMs: 10000

scoring:
  partialCredit: 0.5
  minimumCoverage: 60

variables:
  tenantName: Evaluation tenant
instructions: Test equivalent functionality regardless of product terminology.
```

Paths are resolved from `project.root`; `project.root` is resolved from the config file. A `.env` beside `evalkit.yaml` is loaded without overriding existing environment variables. Strings can reference environment variables as `${NAME}`; missing variables fail validation immediately.

Do not put passwords or tokens in `variables`: prompts and evidence are intentionally retained for reproducibility. Use captured browser sessions for authenticated web flows.

### Local target lifecycle

`target.setup` runs once and must exit successfully. A resumed run skips a previously sealed successful setup. `target.start` remains alive for the run and is terminated as a process group before final artifacts are sealed, including stubborn descendants and failure paths. `target.ready` polls an HTTP URL (any status below 500 is ready) or a shell command, whether or not AEK started the target. The run receipt is refreshed after setup, readiness, and each command grader, so generated or mutated target files record the state that was actually evaluated.

For a deployed web app, omit `setup` and `start`; `ready` is optional but useful for failing early when the deployment is unavailable.

Interrupting `run` or `campaign` with Ctrl+C (`SIGINT`) or `SIGTERM` stops active provider, grader, setup, readiness, and managed target processes before returning exit status 130 or 143. The interrupted run is marked failed and its lock is released. Campaigns retain the interrupted repetition and do not start further repetitions. Timeout cleanup waits for the entire process group, including descendants that outlive the original command.

## Specs

Every YAML file under `paths.specs` is one weighted area. Required area weights must total exactly 100; optional areas are excluded from the headline score.

```yaml
id: checkout
title: Checkout
weight: 35
description: A buyer can complete a safe, persistent checkout.

scenarios:
  - id: CART-S1
    name: Add, update, and persist a cart
    kind: browser              # browser | workspace; defaults from target.kind
    persona: buyer
    dependsOn: []
    requiresAuth: false
    instructions: |
      1. Add the fixture product to the cart.
      2. Change quantity to two and reload.
      3. Capture the persisted total.
    successSignals:
      - Quantity and total remain correct after reload

rubric:
  - id: CART-01
    criterion: Cart quantity and total persist across reload
    weight: 3
    gate: true                    # optional: this item must fully pass
    tags: [crud, persistence, money]
    scenarios: [CART-S1]
    grader: { type: llm }
    passCriteria: Quantity is two after reload and total equals two unit prices.
    evidence: Before/after screenshots with product, quantity, and total.
```

IDs are globally unique and must remain distinct under case folding so the same kit is safe on case-insensitive filesystems. Scenario IDs also cannot use names reserved by the top-level run artifact layout, such as `inputs`, `areas`, or `report.json`. Rubric `scenarios` must refer to scenarios in the same area. Scenario dependencies gate dependent execution across the selected suite; prerequisites execute first, with file order breaking ties. Browser scenarios in the same dependency chain share isolated temporary storage state. An existing captured persona state takes precedence; merely naming an uncaptured persona never creates trusted authentication state, and its chain remains run-local.

### Case matrices, strata, and splits

Use `cases` to execute one scenario against controlled variations without copying its instructions:

```yaml
scenarios:
  - id: CANCEL-S1
    name: Cancel a subscription
    kind: browser
    instructions: Cancel the subscription described by the case variables and verify the final state.
    cases:
      - id: monthly-active
        split: development
        variables: { plan: monthly, accountState: active }
        strata: { plan: monthly, account_state: active }
      - id: annual-past-due
        split: evaluation
        variables: { plan: annual, accountState: past_due }
        strata: [plan=annual, account_state=past_due]
```

Case variables override same-named project variables for that execution. Object strata normalize to stable `dimension=value` labels; the list form is accepted when labels are already normalized. Reports show automatic score and coverage slices for each stratum and retain the case ID and split, but never copy case variables into the public-export format.

Run a split with `aek run --split development` or `aek run --split evaluation`. The CLI defaults to `development`, protecting reserved evaluation cases from routine tuning; `--split all` is an explicit diagnostic option. Scenarios or cases without an explicit split are shared and run in either selection, so existing suites remain compatible. An LLM or hybrid rubric referencing a matrix scenario is evaluated across the selected cases, with a separate automatic diagnostic verdict for every stable rubric/case pair. Its aggregate full `pass` requires every applicable case to pass. A proposed full pass with any unavailable case becomes `cannot_judge`; mixed fully observed outcomes become `partial`. Command and manual-only rubrics remain rubric-level checks.

If a split leaves an area with no applicable rubric items, that area is omitted from the execution and receipt rather than reported as zero coverage. A selection with no applicable rubric items fails before a run directory is created or a provider starts.

For suite-wide dependencies, typed output/input bindings, and isolated saved-persona switching, see [scenario workflows and personas](docs/workflows.md).

When dependent scenarios both use a matrix, reuse the same case IDs, strata, and split in each scenario; their per-step variables may differ. AEK maps `VERIFY--annual` to `CREATE--annual` and validates missing or inconsistent dependency cases before a provider starts. The chosen split is recorded in the run receipt; changing the split or any spec bytes changes the evaluator fingerprint, so evaluation baselines fail closed rather than silently drifting.

Set `gate: true` only on genuinely release-blocking criteria. A critical item must receive a full `pass`; `partial`, `fail`, and `not_found` fail the run, while missing/manual/blocked evidence makes the gate unavailable and also fails closed. Critical gates apply independently of weighted aggregate score and are enforced even when no `--fail-under-*` flags are supplied.

### Grader types

`llm` asks the configured independent judge to assess the collected evidence.

```yaml
grader: { type: llm }
```

`command` is deterministic and runs after the area's scenarios. Every command grader must declare `output: exit-code` or `output: json`; formats are never guessed. In exit-code mode, codes map to `0=pass`, `1=fail`, `2=partial`, `3=cannot_judge`, `4=not_found`, and plain output becomes the reasoning. Other exit codes, signals, and timeouts fail the run. JSON mode requires exit code 0 and an exact, schema-valid JSON object on stdout; malformed output or nonzero exits fail the run instead of falling back to exit-code grading:

```json
{
  "verdict": "pass",
  "confidence": "high",
  "reasoning": "All 143 tests passed.",
  "evidenceRefs": ["graders/TEST-01.stdout.txt"]
}
```

```yaml
grader:
  type: command
  output: exit-code          # use json for the structured object above
  command: node evals/check.mjs
  methodFiles: [evals/check.mjs, evals/expected.json]
  cwd: project                # project | run | path relative to project
  timeoutSeconds: 300
```

`methodFiles` is required. List every checker script, checker dependency, configuration file, and expected-result file that defines the grading method, excluding the product implementation being evaluated. Paths resolve from `project.root`; explicitly declared absolute paths are also supported for shared external checkers. Use `[]` only when the complete check is inline in `command` and has no external evaluator inputs. AEK does not infer dependencies from shell commands or imports.

These files are hashed into the evaluator fingerprint, snapshotted under `inputs/grader-methods/`, hidden from workspace collection, and verified before and after each command grader. Changing a declared checker makes comparisons incompatible and prevents resume; offline rescore keeps the original checker provenance. Missing files fail validation before execution.

Command graders receive `AEK_PROJECT_ROOT`, `AEK_RUN_DIR`, and `AEK_RUBRIC_ID`.

`manual` contributes no score or coverage until finalized:

```yaml
grader: { type: manual }
manualInstructions: Confirm the email arrived once and all links work.
```

`hybrid` splits the item's actual weight between automatic and manual evidence. This is not a provisional verdict that later gets overwritten; both components retain their configured share.

```yaml
grader:
  type: hybrid
  autoShare: 0.6
manualInstructions: Verify the payment appears in the sandbox processor.
```

### Fixtures and uploads

Arbitrary fixture data is passed to scenarios. Browser agents may upload only named paths in the top-level `files` map, preventing them from choosing files elsewhere on disk.

```yaml
data:
  product: Test Widget
  uniqueEmail: aek-buyer@example.test
files:
  avatar: ./files/avatar.png
  importCsv: ./files/import.csv
```

`aek validate` resolves these paths relative to the fixture document and verifies that every entry exists and is a regular file. Missing uploads therefore fail before any provider is started or subscription quota is used.

## Text evaluation

Compare writing directly against selected reference passages using `text-pairwise`.
The judge makes a holistic editorial choice; reference text can express the
desired taste without a detailed style checklist. An optional `styleTarget`
compares two alternatives against a fixed target voice. Text files are snapshotted,
votes resume, and the report includes exact passage citations.

```sh
pnpm aek run --config examples/text/evalkit.yaml --judge codex
```

See the [text example](examples/text/README.md) for direct reference comparisons,
style-guided revisions, and separate voice and editorial-quality evaluations.
See [text evaluation](docs/text-evaluation.md) for the full configuration. Direct text grading requires no collection scenario.

## Visual evaluation and repeated judges

Use controlled browser adapters to capture reproducible PNGs and temporal frames, then grade deterministic checks and blind comparisons against reference images or image-bearing baselines. Pairwise judges distinguish observed equivalence from abstention, retain every vote, and resume without recollecting completed evidence. Ordinary rubric judges can also vote repeatedly over fixed evidence.

See [visual evaluation](docs/visual-evaluation.md) for configuration, adapter contracts, voting policies, diagnostics, baseline images, and limitations. The [dashboard example](examples/visual/evalkit.yaml) runs with a real judge via:

```bash
pnpm aek run --config examples/visual/evalkit.yaml --judge codex
```

The [exported-chart example](examples/artifact/evalkit.yaml) collects a delivered
artifact without a browser and combines an absolute readability gate with a
pairwise non-regression rubric:

```bash
pnpm aek run --config examples/artifact/evalkit.yaml --judge codex
```

Omit `--judge codex` for an offline pipeline check. Its mock judge abstains;
the absolute gate remains unavailable and the CLI exits unsuccessfully.

## Authentication

For magic links, OAuth, or seeded personas, capture Playwright storage state once:

```bash
aek auth --persona buyer --at /login
```

Complete sign-in in the opened browser and press Enter. For a one-click demo role picker:

```bash
aek auth --persona admin --at /demo --click "Sign in as admin"
```

The state is stored beneath an origin-keyed directory in `.agent-eval/auth/` with
private directory and file permissions. Treat it as a password and keep
`.agent-eval/` out of source control. A scenario with `requiresAuth: true` stops
as `blocked` if its persona state is missing; it does not explore the logged-out
app and report false absences.

The kit deliberately does not accept plaintext application passwords in `evalkit.yaml`: provider prompts, exact argv, and raw events are retained for reproducibility. Put non-secret signup identities in fixtures and use captured browser state for existing accounts.

## Run, resume, rescore, finalize

Each completed scenario writes `evidence.json` atomically. Every completed area rebuilds the report, so a late provider or browser failure does not lose earlier work.

```bash
tail -f .agent-eval/runs/<timestamp>/run.log
aek run --resume .agent-eval/runs/<timestamp>
```

Resume reuses non-error scenario evidence and completed area judgements. It requires the current run-state format and its input fingerprint, and refuses changed resolved configuration, provider/evaluator method, selected areas or scenarios, exact spec bytes, fixture manifest or named fixture bytes, and a changed clean Git revision. An exclusive per-run lock rejects concurrent resume or execution before recovery can alter artifacts. Start a new run for changed or unverifiable evaluation inputs.

Every report embeds a versioned receipt and writes the same data to `receipt.json`. It records SHA-256 checksums for evaluation inputs, provider CLI versions, kit/runtime versions, target Git revision when available, and two fingerprints: a strict input fingerprint for resume and an evaluator fingerprint for safe cross-target comparison. Receipt creation fails if a configured provider's CLI version cannot be determined; run `aek doctor` instead of producing an unverifiable receipt. Receipt files contain hashes and metadata, not fixture contents or secrets.

After changing only scoring weights/tags, intentionally apply the current specs without a model call. Rescore requires the sealed original resolved-config snapshot and uses its original scoring values when checking that no unrelated collection settings changed:

```bash
aek rescore --run .agent-eval/runs/<timestamp>
```

For pending manual checks, edit `manual-results.json`, then:

```bash
aek finalize --run .agent-eval/runs/<timestamp> --reviewer dean
```

Finalization appends a hashed entry to `manual-revisions.ndjson` for every changed manual or hybrid result. Each revision records its reviewer, timestamp, verdict, notes, and the previous revision hash. Re-running finalize without a change does not create a duplicate revision. Unknown rubric IDs and invalid completed verdicts are rejected. If `--reviewer` is omitted, AEK uses the reviewer saved in the entry or the local operating-system username; if none is available, finalization requires `--reviewer` instead of recording an anonymous revision.

Every report update also writes `artifact-index.json`, which checksums retained inputs, evidence, screenshots, provider events, judgements, review history, and reports. Verify a run explicitly with:

```bash
aek verify --run .agent-eval/runs/<timestamp>
```

Resume, compare, rescore, finalize, and baseline promotion verify an existing index before trusting its artifacts. `manual-results.json`, `run-state.json`, `run.log`, temporary files, and generated comparisons are documented mutable exclusions; finalized review revisions and rebuilt reports are sealed into the next index.

## Repeated-run campaigns

Coding-agent results are stochastic, so AEK can execute the same resolved evaluation sequentially several times:

```bash
aek campaign --repetitions 5
aek campaign --repetitions 5 --areas checkout --output .agent-eval/campaigns/checkout
```

Each repetition remains a normal independently receipted run. `campaign.json` and `campaign.html` report completion failures, score and coverage mean/median/range/standard deviation, deterministic 95% percentile-bootstrap intervals using the complete run as the resampling unit, critical-gate pass rate, and rubric, case, and stratum verdict stability. Aggregate metrics are withheld if evaluator or strict target-input fingerprints differ. Campaigns are deliberately sequential to avoid subscription concurrency and rate-limit surprises. Intervals are descriptive and small repetition counts remain unstable. A campaign does not reset a deployed target's database: use idempotent scenarios, isolated test tenants, or a lifecycle setup command that restores state between runs.

An incompatible campaign exits with status `2` even if every individual repetition passes its numeric thresholds; execution failures take precedence with status `1`. Hybrid rubric stability counts a full pass only after every required automatic and manual share passes. Pending hybrid reviews retain automatic credit and `components.automatic`, while their aggregate verdict is `cannot_judge` until review is complete. Case and stratum diagnostics continue to describe automatic judgements.

Compare two campaigns over matching stable cases:

```bash
aek campaign compare \
  --baseline .agent-eval/campaigns/before \
  --candidate .agent-eval/campaigns/after \
  --fail-on-regression
```

The comparison reports each case's mean verdict value across repetitions, improvement/regression and coverage/add/remove states, stratum-level mean deltas, and a deterministic 95% paired-case bootstrap interval. The resampling unit is the matched case, so large matrices do not get confused with random repetition noise. Numeric results are withheld when evaluator fingerprints differ unless `--allow-incompatible` is explicitly recorded. `--fail-on-regression` exits with status `2` after writing the JSON and HTML reports if a case regresses, loses coverage, or disappears, or if the campaign mean score, critical-gate pass rate, or completion rate falls. Completion rate is completed runs divided by attempted runs; pending repetitions are excluded. It is checked even for campaigns without case results. Execution failures remain separate from product scores and evidence coverage.

## CI thresholds

Add score and evidence-coverage gates directly to a run:

```bash
aek run --fail-under-score 85 --fail-under-coverage 90
```

The same flags work with `rescore` and `finalize`. Critical rubric items marked `gate: true` are always enforced as hard gates. Artifacts are written first; any failed or unavailable critical gate or numeric threshold exits with status `2`. A withheld or unavailable score cannot pass `--fail-under-score`, even if its provisional numeric value is high. Invalid thresholds and execution errors use status `1`.

Run, rescore, and finalize thresholds and score withholding use full-precision weights, allowing only machine-level arithmetic roundoff at equality. Display percentages are rounded: a displayed 100% may still fail a 100% requirement; the failure message includes the unrounded measurement.

## Compare runs

Compare two run directories—or two explicit `report.json` files whose parent directories are sealed runs—without another agent call:

```bash
aek compare \
  --baseline .agent-eval/runs/2026-09-01T12-00-00 \
  --candidate .agent-eval/runs/2026-09-04T12-00-00
```

This writes `comparison.json` and a standalone `comparison.html` below the candidate run's `comparisons/vs-<baseline-run-id>/` directory. The report includes overall, area, tag, and rubric-item deltas; item changes distinguish improvements, regressions, gained/lost coverage, additions, and removals.

Rubric items retain weighted score and coverage measurements, so hybrid regressions are detected even when both aggregate verdicts are `partial`. Campaign case coverage is judgeable repetitions divided by all attempted repetitions, including failed runs; pending runs are excluded. `--fail-on-regression` detects partial case coverage loss and decreases in campaign mean evidence coverage. See [release validation](docs/release-validation.md#comparison-and-recovery-corrections-013) for artifact regeneration and interrupted-lock recovery.

Comparisons require current, receipt-bearing reports and a valid `artifact-index.json` for both direct inputs. They verify that both have the same evaluator fingerprint: kit version, provider versions/configuration, scoring method, variables/instructions, selected inputs, exact specs, and exact fixtures. Incompatible reports still produce an audit report, but numeric deltas are withheld and the command exits with status `2`. Use `--allow-incompatible` only for exploratory analysis; it records the override and enables deltas explicitly.

Promote a reviewed run to a named baseline, then compare against that name:

```bash
aek baseline promote --run "$BASE_RUN" --name main --reviewer dean
aek baseline list
aek compare --baseline-name main --candidate "$CANDIDATE_RUN" --fail-on-regression
```

Promotion requires a valid `run-state.json` with `status: complete`, then verifies the source artifact index. Every promotion creates a new content-checked snapshot containing the comparison-relevant report fields, source report and artifact-index hashes, evaluator fingerprint, target revision, reviewer, and timestamp. Full scenario evidence and judge reasoning remain in the source run rather than being copied into the baseline. Updating a name moves only its atomic `current.json` pointer; previous snapshots remain available in the baseline directory. The default `evals/baselines` location is evaluator-hidden and suitable for code review and version control.

Optional comparison gates also exit with status `2` after writing the report:

```bash
aek compare --baseline "$BASE_RUN" --candidate "$CANDIDATE_RUN" \
  --fail-on-regression --max-score-drop 2 --max-coverage-drop 5
```

`--fail-on-regression` treats a lower item verdict, lost item coverage, a removed item, or a removed area as a regression. Score-drop enforcement fails closed when either headline score was withheld, because the two scores are not safely comparable.

## Public export and privacy lint

Create a small shareable package from an integrity-verified run:

```bash
aek export --public --run .agent-eval/runs/<timestamp>
```

The default destination is `.agent-eval/exports/<run-id>/`. The export contains aggregate, area, rubric, case, stratum, split, provider, source-hash, and gate outcomes. It deliberately excludes target URLs and absolute paths, fixtures and case variables, prompts and evaluator instructions, transcripts and observations, screenshots and provider events, defects and notes, evidence references, and grader reasoning. `--public` is required so this lossy boundary is explicit.

Before publishing atomically, AEK scans every exported text file for private keys, bearer and known API-token formats, probable secret assignments, email addresses, user home paths, and credentials embedded in URLs. Findings name only the rule and file/line; they never echo the matched value. A failed scan publishes nothing. You can run the same heuristic scanner independently:

```bash
aek privacy lint --path path/to/proposed-artifact
```

The lint is a guardrail, not proof of anonymity: product-specific customer IDs or sensitive business labels may not match a generic pattern and still require human review. Binary files are skipped and counted; public exports contain no binary evidence by design.

## Provider behavior

| Provider | Scenario mode | Structured result | Subscription authentication |
|---|---|---|---|
| Codex | `codex exec --json --ephemeral` | `--output-schema` | saved ChatGPT sign-in |
| Claude Code | `claude -p --output-format stream-json` | `--json-schema` | saved `claude.ai` sign-in |
| Grok Build | headless `--prompt-file` | `--json-schema` | saved Grok browser/device login |

Codex is the default and most-tested adapter. Claude Code and Grok Build are first-class adapters, but their CLIs evolve independently; `aek doctor` records the installed versions, and every invocation stores its exact argv, raw events, stderr, model, session id, and token usage when exposed.

`doctor` checks installation and local authentication status, not remaining model quota or successful OAuth refresh. Use the opt-in provider smoke to verify actual collection and judging. Claude and Grok preserve provider-written credential refreshes before removing their temporary configuration homes, provided the original credential file has not changed during the invocation.

The offline `mock` provider exists for harness tests. It does not inspect a target and should not be used for real LLM-graded evaluations.

## Evidence and safety model

- Browser top-level navigation is exact-origin by default. Sibling subdomains require an explicit wildcard.
- Each scenario gets a fresh provider context and isolated artifact directory.
- Real scenario and judge providers execute from disposable working directories outside the target's instruction-file scope. Provider arguments that could import external instructions, sessions, agents, or rules are rejected; Claude also receives an isolated configuration home containing only copied subscription credentials. Browser actions use the allowlisted Playwright MCP; workspace inspection uses a path-contained, read-only MCP with list/read/literal-search tools. The workspace view hides the eval config, specs, fixture manifest, named fixture files, prior runs, and VCS metadata. Executable project checks belong in explicitly configured command graders.
- Repository scenario prompts contain scenario instructions and success signals, but not rubric criteria or pass thresholds. Attempts by Codex or Claude to use provider-native shell/file/web tools across the MCP evidence boundary invalidate the scenario.
- Judges cannot revisit the target and receive only the evidence bundle plus capped, round-robin screenshot attachments.
- Judges receive canonical IDs for scenario records, observations, screenshots, and transcript steps. Unknown or out-of-scope citations, non-`cannot_judge` verdicts without citations, and defects without reached evidence fail the judge contract with retained diagnostics. Explicit abstentions may omit citations.
- Screenshot citations in non-abstaining item/case verdicts and defects require actual image access: a selected direct attachment for Codex, or a successful evidence MCP view for other judges. Unselected images and failed views cannot support visual claims. Text-only judgments and explicit abstentions do not require image views.
- Judges must return exactly the requested rubric and case identities. Missing, unexpected, or duplicate results abort the run; only an explicit `cannot_judge` counts as an abstention.
- Raw provider output is retained. Provider timeouts, nonzero exits, evidence-boundary violations, malformed structured answers or events, missing scenario finalization, and corrupt transcripts abort the run with diagnostics instead of being mislabeled as model uncertainty. A valid judge abstention still becomes unavailable coverage.
- Command strings in configuration are trusted project code. Review them before running an eval kit from someone else.

This is evaluation infrastructure, not a hardened hostile-code sandbox. Run untrusted projects in a disposable container or VM.

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

## Development

See [shared judging contracts](docs/judging-contracts.md) for identity, evidence, image-access, and case-aggregation rules across grading modes.
See [internal boundaries](docs/internal-boundaries.md) for run recovery, input provenance, browser interactions, and scoring responsibilities.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke:browser
pnpm smoke:browser:full
pnpm test:reference
pnpm smoke:package
pnpm build
```

Code linting uses [Biome](https://biomejs.dev/) with its recommended preset. Run `pnpm lint:fix` to apply safe fixes. Run `pnpm format` to format code and `pnpm format:check` to verify formatting. Formatting uses two spaces and a 100-column line width; CI enforces it. Import organization is disabled. The configuration allows non-null assertions, string concatenation, explicit null guards, and assignments in loop conditions to preserve existing code conventions. Lint warnings fail CI. The `noFloatingPromises` and `noMisusedPromises` rules are explicitly enforced as errors.

TypeScript enforces strict mode, checked indexed access, exact optional properties, explicit return paths, switch fallthrough checks, explicit overrides, and unused-code checks. Omit absent optional fields instead of assigning `undefined`; validate required indexed values before using them.

The fast browser smoke covers the basic contract. The full regression fixture covers SPA click targets, custom dropdowns, rich-text editors, temporal inputs, iframes, open shadow DOM, modal scoping, overlays, nested upload controls, drag-and-drop, inner scroll containers, origin containment, synthesized labels, ref-budget collapse, and bounded screenshots.

The CI workflow runs these checks on Linux with Node 20.12, 22, and 24. Package smoke builds a tarball, installs production dependencies in a temporary consumer, and exercises the installed CLI and workspace MCP without TypeScript source or `tsx`.

Reference checks contain working, broken, and missing cart-total implementations with separately specified expected outcomes. The default command uses deterministic graders and no model quota. To measure a real collector/judge pair or check a provider's browser and workspace integration:

```bash
pnpm test:reference --provider codex --judge claude --repetitions 3
pnpm smoke:provider --provider codex
pnpm smoke:provider --provider claude
pnpm smoke:provider --provider grok
```

These opt-in commands use the selected subscriptions and retain versioned, integrity-checked reports under `.agent-eval/reference/`. Each provider invocation is capped at 180 seconds and 20 turns/interactions. See [release validation](docs/release-validation.md) for interpretation, known limits, and the provider verification record.
