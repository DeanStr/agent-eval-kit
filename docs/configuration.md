# Configuration reference

This reference describes `evalkit.yaml`. Scenario and rubric YAML lives in the
files selected by `paths.specs`; see [spec definitions](../README.md#specs) and
the [evaluation-type guides](evaluation-types.md). Run `aek validate` to check
configuration, specs, fixtures, and declared input files. Unknown fields fail.

## Editor support

`aek init` writes generated JSON Schemas into `evals/schemas/` and adds
`yaml-language-server` associations to the generated config and specifications.
Editors that support these associations can complete fields and flag structural
errors while you type. Keep the schema files with your project-owned kit.

Existing projects can reference the installed schemas at
`node_modules/agent-eval-kit/dist/schemas/config.schema.json` and `spec.schema.json`;
resolve the association relative to each YAML file. For a root config:

```yaml
# yaml-language-server: $schema=./node_modules/agent-eval-kit/dist/schemas/config.schema.json
```

Schemas are generated from the runtime field contracts during the package build
and initialization. They describe templates, external dataset references, and
named suites; `aek validate` remains authoritative for cross-field rules,
expanded templates, references, and filesystem checks. Regenerate a starter in a
new directory to obtain schema updates for an existing kit.

## Resolution and overrides

- The default config is `evalkit.yaml` in the current directory; use `--config`
  to choose another file. `project.root` resolves from the config directory.
- `paths.*`, lifecycle working directories, and ordinary spec input paths resolve
  from `project.root`. Fixture uploads resolve from the fixture document; dataset
  manifest paths resolve from the spec document. Grader `methodFiles` may also
  explicitly name absolute shared checker paths. Individual input types enforce
  their documented containment rules.
- A `.env` beside the config is loaded without replacing existing environment
  values. `${NAME}` references in config strings require that environment variable;
  missing variables fail. Variables and instructions are retained evaluation data.
- Resolution order is root configuration, selected suite overrides, then explicit
  CLI overrides. Resume restores the saved selection and CLI overrides. Campaign
  resume accepts only its directory and restores every original option and threshold.
- Defaults below apply when a field is omitted. An omitted optional object is
  disabled unless stated otherwise; it is not the same as an explicitly empty object.

## Project and target

| Field | Type / default | Contract |
| --- | --- | --- |
| `version` | Required integer `1` | Config format version. |
| `project.name` | Required nonempty string | Name shown in reports. |
| `project.root` | String, `.` | Project directory relative to this config. |
| `target.kind` | Required: `web`, `repository`, `command` | `artifact` is an init starter, not a target kind. |
| `target.url` | HTTP(S) URL | Required for `web`; embedded username/password rejected. |
| `target.allowedOrigins` | String array, `[]` | Target origin is always included. Additional origins are exact unless an explicit wildcard such as `https://*.example.test` is supplied. |
| `target.setup` | Optional command | Runs before each new evaluation, including each campaign repetition. A sealed successful setup is reused on ordinary run resume. |
| `target.start` | Optional command | Starts a managed server and keeps it alive until cleanup. |
| `target.allowExternalServer` | Boolean, effectively `false` | Permit reuse of an already listening server and skip `start`; otherwise an occupied managed endpoint fails. |
| `target.ready` | Optional readiness object | Wait for the target before collecting evidence. Works with managed or external targets. |
| `target.fingerprint.exclude` | Optional array of up to 50 project-relative paths | Explicit generated-artifact exclusions from Git/non-Git target identity. Paths are literal, cannot name the root or escape it, and are included in evaluation/collection compatibility. |

Use fingerprint exclusions for project-owned evidence archives that are not
runtime inputs, for example `fingerprint: { exclude: [output] }`. These exclusions
apply before file-count and byte limits, including to ignored Git files. Keep
application source, executed builds, environment files, and runtime data in the
target identity. Exclusions also apply inside initialized Git submodules, including
nested submodules; their non-excluded runtime inputs and revisions remain fingerprinted.
Declared collector sources and grader/collector method files
remain independently snapshotted and verified even inside an excluded directory.
Changing the exclusion policy changes evaluator compatibility and prevents resume
or detached evidence reuse under a different policy. Execution previews expose it.

`--url` is available only for web targets. It replaces the configured target origin
in the effective allowlist and rewrites a readiness URL on that same origin;
other explicitly allowed origins and external readiness URLs remain as configured.

Both `setup` and `start` accept a command string or this object:

| Command field | Type / default | Contract |
| --- | --- | --- |
| `command` | Required nonempty string | Trusted shell command. |
| `cwd` | String, project root | Working directory. |
| `env` | Optional string-to-string map | Additional process environment. |
| `timeoutSeconds` | Optional positive number | Setup defaults to 600 seconds. The shared schema accepts this on `start`, but it does not impose a server lifetime; use readiness deadlines to bound startup. |

Readiness fields:

| Field | Type / default | Contract |
| --- | --- | --- |
| `target.ready.url` | HTTP(S) URL | Exactly one of `url` and `command` is required. An HTTP status below 500 establishes readiness. |
| `target.ready.command` | Nonempty string | Shell readiness probe; successful exit establishes readiness. |
| `target.ready.timeoutSeconds` | Positive number, `120` | Overall readiness deadline. |
| `target.ready.intervalMs` | Positive integer, `500` | Delay between probes. |

Setup receives `AEK_PROJECT_ROOT` and `AEK_RUN_DIR`. Managed processes and their
descendants are stopped on completion, failure, or cancellation. Application data
reset remains project-owned. See [target lifecycle](../README.md#local-target-lifecycle).

## Agent and judge

Both sections accept these fields. Omitting either section selects Codex with
a 1,800-second invocation timeout and no extra arguments.

| Field under `agent` or `judge` | Type / default | Contract |
| --- | --- | --- |
| `provider` | `codex` (default), `claude`, `grok`, `cursor`, `mock` | Independent collection/judging choices. Mock uses no subscription and cannot establish model quality. |
| `model` | Optional nonempty string | Provider-specific model ID or alias; omitted uses the provider CLI default. |
| `effort` | Optional nonempty string | Provider-specific reasoning effort. |
| `maxTurns` | Optional positive integer | Claude/Grok provider turn cap. Codex collection uses an MCP interaction cap, default 50 when omitted. Codex has no native judge turn-limit flag. |
| `timeoutSeconds` | Positive integer, `1800` | Per-provider invocation timeout. |
| `extraArgs` | String array, `[]` | Additional allowed CLI arguments. Arguments importing external instructions, tools, sessions, or changing the evidence boundary are rejected. |

`--agent`, `--judge`, `--agent-model`, and `--judge-model` override the respective
fields. `--max-turns` overrides **agent** interaction limits. Controlled capture
and command collectors do not call the scenario agent. Direct text grading does
not require a collection scenario. Use `aek doctor` for local provider readiness.

Judge-only fields:

| Field | Type / default | Contract |
| --- | --- | --- |
| `judge.voting` | Optional voting object | Repeated ordinary LLM/hybrid judging; omission uses one judge invocation per area. Also supplies defaults for direct text graders. |
| `judge.capacityRetries` | Integer 0–5, default `0` | Retry explicit temporary capacity failures with bounded exponential backoff. Retains failed attempts; never retries valid verdicts, timeouts, policy violations or scenario collection. See [image comparison](image-comparison.md#temporary-provider-capacity-failures). |
| `judge.concurrency` | Integer 1–8, effective default `1` | Concurrent image-pairwise, text-pairwise and text-rubric workers; votes/references within a worker remain sequential. Does not parallelize ordinary LLM areas or campaign repetitions. |

Voting object fields:

| Field | Default | Limits |
| --- | --- | --- |
| `minimumVotes` | `5` | Integer 1–25. |
| `maximumVotes` | `9` | Integer 1–25, at least `minimumVotes`. |
| `agreement` | `0.8` | Greater than 0.5, at most 1. |
| `minimumConfidence` | `0.55` | Number from 0 to 1. |

Image-pairwise graders use their own `grader.voting` policy (default 5–9 votes),
independently of `judge.voting`. Direct text graders use `grader.voting`, then
`judge.voting`, then the same built-in 5–9 defaults. Ordinary repeated judging
batches the area's requested rubric items and cases in each fresh context.
Valid abstentions and votes below the configured confidence cutoff reduce coverage; missing required results
and invalid responses are execution errors. See [judging contracts](judging-contracts.md).

## Paths

| Field | Default | Purpose |
| --- | --- | --- |
| `paths.specs` | `evals/specs` | Spec file or directory of area specs. |
| `paths.fixtures` | Omitted | Optional JSON/YAML fixture document. |
| `paths.runs` | `.agent-eval/runs` | Private run artifacts. |
| `paths.auth` | `.agent-eval/auth` | Private captured browser sessions. |
| `paths.baselines` | `evals/baselines` | Promoted score snapshots and optional images. |
| `paths.references` | `evals/text-references` | Promoted text snapshots; must remain within the project root. |

Campaigns, public exports, and their default directories are described in
[artifact layout](../README.md#artifact-layout). Commands that accept `--output`
can choose their documented destination. Keep private evidence and authentication
out of source control.

## Browser

| Field | Type / default | Contract |
| --- | --- | --- |
| `browser.headless` | Boolean, `true` | `--headed` overrides it to `false`. |
| `browser.readOnlyFrames` | Optional array, up to 10 `{pathPrefix, selector}` policies | Evidence-only opt-in for direct, fully sandboxed `srcdoc` iframes on the configured application origin. Prefixes must end in `/`. No interactive references are granted; other frames remain subject to the origin policy. |
| `browser.viewport.width` | Integer, `1280` | From 1 to 2,000 pixels. |
| `browser.viewport.height` | Integer, `800` | From 1 to 2,000 pixels. Both dimensions are required when supplying `viewport`. |
| `browser.actionTimeoutMs` | Positive integer, `10000` | Ordinary browser action deadline. Controlled capture has separate deadlines. |
| `browser.screenshotFormat` | Optional `jpeg` or `png` | Ordinary screenshots default to JPEG. Controlled capture always uses PNG. |
| `browser.diagnostics.failOn` | Array, `[]` | Any of `console`, `pageerror`, `requestfailed`, `http`. Attach a capture grader to score these checks. |
| `browser.diagnostics.ignoreUrls` | String array, `[]` | Literal URL substrings excluded from diagnostic checks; events are still retained. |

See [controlled capture](visual-evaluation.md#controlled-browser-capture) for
scenario-level seeds, frame/pass counts, time stepping, metrics, image health,
renderer selection, and timeout settings. These are `scenario.capture` fields,
not `browser` fields.

## Scoring and promotion

| Field | Type / default | Contract |
| --- | --- | --- |
| `scoring.partialCredit` | Number 0–1, `0.5` | Points for an observed partial result. |
| `scoring.minimumCoverage` | Percentage 0–100, `60` | Withhold headline score below this evidence coverage. This alone is not a CI exit gate. |
| `promotion.minimumCoverage` | Percentage 0–100, `100` | Release baseline coverage threshold. |
| `promotion.minimumScore` | Optional percentage 0–100 | Additional release score threshold. |
| `promotion.split` | `all` (default), `development`, `evaluation` | Required split for release promotion. |
| `promotion.includeOptional` | Boolean, `false` | Require optional areas during release promotion. |

Omitting `promotion` still applies the default release policy: complete required
suite, split `all`, 100% coverage, and passed critical gates. Milestone promotion
requires an explicit mode and reason. See [promotion policies](evidence-workflows.md#baseline-promotion-policy).

CLI `--fail-under-score` and `--fail-under-coverage` add acceptance thresholds;
they do not change rubric weighting. Critical `gate: true` items independently
require a full pass. A withheld score cannot satisfy a score threshold. Reports
are written before acceptance failure exits 2. Execution errors exit 1.

## Variables, instructions, and suites

| Field | Type / default | Contract |
| --- | --- | --- |
| `variables` | String-keyed map, `{}` | Project data passed to scenarios; case variables override matching keys. Values can be structured data. |
| `instructions` | Optional string | Global evaluation guidance. |
| `suite` | Optional nonempty string | Default selected suite. |
| `suites` | Optional map of suite names to overrides | Requires explicit `--suite` or a configured default; no implicit first suite. |

Suite overrides accept only `agent`, `judge`, `paths`, `scoring`, and
`instructions`. Object sections merge one level; nested objects such as
`judge.voting` replace the whole nested object. All suite definitions validate,
including unselected ones. Each suite produces its own resolved evaluation and
report. See [named-suite example](text-evaluation.md#shared-defaults-and-named-suites).

## Mailboxes and email authentication

`mailboxes.<name>` declares an existing recipient mailbox:

| Field | AgentMail | Mailpit |
| --- | --- | --- |
| `provider` | Required `agentmail` | Required `mailpit` |
| `address` | Required email address | Required email address |
| `inboxId` | Required nonempty string | Not accepted |
| `apiKeyEnv` | Required environment-variable name matching `[A-Z][A-Z0-9_]*` | Not accepted |
| `baseUrl` | Default `https://api.agentmail.to/v0`; HTTPS or loopback HTTP, no credentials/query/fragment | Required loopback HTTP origin, no path/credentials/query/fragment |

`emailAuth.<persona>` declares a web login flow. The persona cannot be `anonymous`.

| Field | Type / default | Contract |
| --- | --- | --- |
| `mailbox` | Required string | Name in `mailboxes`. |
| `startPath` | Required string | Target-relative path beginning with one slash. |
| `emailSelector` | Required string | Email input selector. |
| `requestSelector` | Required string | Control that requests the message. |
| `message.from` | Required email address | Exact expected sender. |
| `message.subject` | Required nonempty string | Exact expected subject. |
| `credential.type` | Required `link` or `code` | Selects the fields below. |
| `credential.path` | Required for `link` | Target-relative credential URL path. |
| `credential.parameter` | Required for `link` | Credential query parameter name. |
| `credential.length` | Integer 4–12, `6` | Code length; code flows only. |
| `credential.selector` | Required for `code` | Code input selector. |
| `credential.submitSelector` | Required for `code` | Submission control selector. |
| `success.selector` | Required nonempty string | Authenticated identity element. |
| `success.text` | Required nonempty string | Expected identity text. |
| `timeoutSeconds` | Positive number up to 300, `120` | Authentication deadline. |
| `pollIntervalMs` | Integer 100–10000, `1000` | Mailbox polling interval. |

Use `aek auth --persona <name> --email` to capture a session, or declare
`authenticateEmail: true` on a browser scenario. The latter cannot combine with
`requiresAuth`, `allowedPersonas`, or controlled capture. API keys are read only
at execution. See [email workflows](email.md) for credential handling and examples.

## Validate and preview

```sh
aek validate --config evalkit.yaml
aek run --config evalkit.yaml --dry-run --json
aek collect --config evalkit.yaml --dry-run --json
aek campaign --config evalkit.yaml --repetitions 3 --dry-run --json
```

Previews validate inputs and show selected collectors, all graders, dependency
order, services, and conditional judge-call ranges without creating output or
invoking a provider. See [execution previews](cli.md#execution-previews) for the
versioned JSON contract and its limits. Use `aek <command> --help` for the exact
options accepted by that command or subcommand.

Cursor uses the `cursor-agent` executable with saved file credentials. It supports `model` and `timeoutSeconds`; `effort`, `maxTurns`, and `extraArgs` are rejected. See [Cursor setup](../README.md#provider-behavior).
