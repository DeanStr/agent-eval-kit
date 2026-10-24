# Provider behavior

AEK runs scenario collection and judging through coding-agent CLIs that are
already signed into a subscription. Select providers with the `agent` and
`judge` sections of `evalkit.yaml` (see [agent and judge fields](configuration.md#agent-and-judge))
or with `--agent` and `--judge`.

| Provider | Scenario mode | Structured result | Subscription authentication |
|---|---|---|---|
| Codex | `codex exec --json --ephemeral` | `--output-schema` | saved ChatGPT sign-in |
| Claude Code | `claude -p --output-format stream-json` | `--json-schema` | saved `claude.ai` sign-in |
| Grok Build | headless `--prompt-file` | `--json-schema` | saved Grok browser/device login |
| Cursor | `cursor-agent --print --output-format stream-json` | schema in prompt, validated by AEK | saved Cursor file credentials |

Codex is the default and most-tested adapter. Claude Code, Grok Build, and Cursor are supported adapters, but their CLIs evolve independently; `aek doctor` records the installed versions, and every invocation stores its exact argv, raw events, stderr, model, session id, and token usage when exposed.

The adapter contracts follow the official automation surfaces: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), and [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting).

## Readiness and credentials

`doctor` checks installation and local authentication status, not remaining model quota or successful OAuth refresh. Use the opt-in provider smoke to verify actual collection and judging. Claude, Grok, and Cursor preserve provider-written credential refreshes before removing their temporary configuration homes, provided the original credential file has not changed during the invocation.

See [development](development.md) for the opt-in provider smoke commands, and
[receipts and provider settings](runs.md#receipts-and-provider-settings) for how
requested models and effort are recorded.

## Cursor

For Cursor, install the [Cursor CLI](https://cursor.com/docs/cli/installation), then run:

```bash
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login
aek doctor --providers cursor
aek run --agent cursor --judge cursor
```

AEK uses `cursor-agent` explicitly because the `agent` command can belong to another provider. Cursor runs with an isolated home and only its saved `auth.json` credentials; on macOS, the file-store login above is required even if you have already signed in using Keychain. Linux credentials are read from `$XDG_CONFIG_HOME/cursor/auth.json` or `~/.config/cursor/auth.json`; macOS uses `~/.cursor/auth.json`. Ambient API keys and user settings are not passed through. Browser/workspace collection and image judging use AEK's MCP servers.

Cursor supports `model` and `timeoutSeconds`. Separate `effort`, `maxTurns`, and `extraArgs` settings are rejected. Its [CLI output format](https://cursor.com/docs/cli/reference/output-format) does not enforce a JSON Schema: AEK supplies the schema in the prompt and validates the final answer. Malformed answers fail the run. Cursor token usage is not reported when the CLI does not expose it.

## Mock provider

The offline `mock` provider exists for harness tests. It does not inspect a target and should not be used for real LLM-graded evaluations.
