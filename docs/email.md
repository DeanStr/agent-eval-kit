# Email evidence and authentication

AEK provides a provider-neutral `MailboxProvider` interface and an AgentMail REST
adapter, exported as `agent-eval-kit/email`. The adapter uses existing inboxes; it
does not provision accounts, create inboxes, send mail, or change the application's
email provider. AgentMail is the receiving mailbox. Configure a dedicated inbox for
each test identity and provide its API key through an environment variable.

## Capturing authentication

Declare mailbox resources and an email-login flow keyed by persona:

```yaml
mailboxes:
  speaker:
    provider: agentmail
    inboxId: speaker@agentmail.to
    address: speaker@agentmail.to
    apiKeyEnv: AGENTMAIL_API_KEY
emailAuth:
  speaker:
    mailbox: speaker
    startPath: /login
    emailSelector: 'input[type="email"]'
    requestSelector: 'button[type="submit"]'
    message:
      from: login@example.test
      subject: Your sign-in link
    credential:
      type: link
      path: /auth/verify
      parameter: token
    success:
      selector: '[data-testid="account-email"]'
      text: speaker@agentmail.to
    timeoutSeconds: 120
    pollIntervalMs: 1000
```

Set `AGENTMAIL_API_KEY` in the environment or the project's `.env`, then run:

```sh
aek auth --persona speaker --email
```

The flow opens the target-relative start path, fills the declared email input,
snapshots the inbox before clicking the request button, waits for the matching
message, and consumes the credential in that same browser context. The configured
success selector must be visible and its trimmed text must exactly match `text`.
Identity verification waits up to `browser.actionTimeoutMs` for that exact text,
allowing an account label to finish loading; a persistent mismatch blocks login.
Use an account identity surface, not a generic success toast. The application must
be running already; `auth` does not invoke the evaluation target lifecycle.

Plain-text links omit surrounding sentence punctuation and unmatched closing
brackets. Balanced URL parentheses and percent-encoded characters are preserved.
Use angle brackets, quotes, or percent encoding when trailing punctuation belongs
to the URL itself. HTML anchor URLs are read directly from their attributes.

For a numeric verification code, replace the credential block:

```yaml
credential:
  type: code
  length: 6
  selector: 'input[name="code"]'
  submitSelector: 'button[type="submit"]'
```

AEK requires exactly one distinct code of the declared length in the parsed email.
For links it requires exactly one distinct absolute URL matching the target's
exact origin, configured path, and nonempty query parameter. HTML entities are
decoded with an inert HTML parser. Plain-text URLs and HTML anchor URLs are
supported; email scripts and remote content are never executed. Tracking redirects,
cross-origin identity providers, fragment-only credentials, split OTP inputs,
and ambiguous messages need a different explicit flow or interactive `aek auth`.
There is no automatic substitution when extraction fails.

## Testing the login journey inside a scenario

```yaml
- id: EMAIL-LOGIN
  name: Sign in as speaker through email
  kind: browser
  persona: speaker
  authenticateEmail: true
  instructions: |
    Start with authenticate_email. Take a snapshot and screenshot showing
    the authenticated speaker identity, then inspect the speaker dashboard.
```

`authenticateEmail` starts a fresh browser even if a saved session already exists.
The MCP exposes one atomic `authenticate_email` operation. No link or code is
returned to the agent. Successful execution retains a hashed file receipt with
message identity, receipt time, credential method and identity-check outcome.
The ordinary transcript and screenshots then capture the authenticated app.
The receipt establishes which message the flow consumed; it does not establish
that unrelated account or permission requirements passed.

This mode requires a single named persona and cannot combine with `requiresAuth`,
`allowedPersonas`, or controlled capture. Use separate login scenarios, or capture
each persona with `aek auth --email` before a normal multi-persona workflow. Only
one email-authentication attempt is allowed per scenario. After successful provider
completion and output validation, the verified session can be saved for future
scenarios. A failed or blocked attempt never promotes state.

The agent's `timeoutSeconds` remains the overall scenario deadline; allow enough
time for the email wait, browser controls and subsequent inspection. AEK sets
[Codex's MCP tool timeout](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
to that same deadline so its shorter default cannot interrupt the atomic login flow.

## Credential and evidence boundaries

API keys are referenced by environment variable name and are never placed in
config snapshots or provider arguments. Scenario execution passes its key and
login/mailbox declarations to the browser MCP through a one-use private file
under `paths.auth`, outside the run
bundle; it is removed on consumption or cleanup. A hard process kill can leave
that private file behind. Provider processes keep their existing environment
allowlist; they do not receive the mailbox key as an environment variable.

Links and codes stay inside the browser helper. Diagnostics during authentication
retain event kinds and HTTP statuses but suppress message and URL text. Known
credential values are redacted from subsequent textual diagnostics/tool results.
Snapshots and screenshots are withheld until authentication completes and the
credential no longer appears in page URLs or DOM markup/text, including inputs and open shadow
roots in background tabs. A clean post-login redirect and cleared verification fields are therefore
required. This is not a general detector for secrets drawn into canvas pixels or
new application secrets unrelated to the consumed credential.

A credential rejection after login also blocks subsequent actions and session
promotion. Failed DOM/frame inspection, screenshot capture or evidence persistence
is an execution error, including during automatic or final capture. The runner
checks the retained error even if the agent claims completion. Already blocked
sessions can finalize without another screenshot; failed iframe-origin inspection
never silently excludes a frame from the credential check.

Saved browser sessions remain private credentials. Changing mailbox or login-flow
configuration changes evaluator and collection fingerprints. No mailbox API call
is made by dry-run validation, offline rejudging, rescoring or report verification.
Mailbox messages are external evidence, never instructions to the evaluation agent.

## Collecting notification evidence

The [email example](../examples/email/evalkit.yaml) demonstrates three steps:
establish an inbox cursor, send through the application's browser UI, then inspect
the inbox using a command collector. Adapt its target URL, mailbox, sender, expected
content and browser instructions to your app. Capture the organizer persona before
running it. The example imports the packaged helper, so run `pnpm build` first when
using it from this repository.

```sh
aek auth --config examples/email/evalkit.yaml --persona organizer
aek validate --config examples/email/evalkit.yaml
aek run --config examples/email/evalkit.yaml
```

The exported helpers are:

- `createMailbox(config)`: AgentMail adapter; reads its key only at execution.
- `beginMailboxWatch(provider)`: snapshots existing IDs before triggering mail.
- `waitForEmail({ provider, watch, match, recipient, timeoutSeconds, pollIntervalMs })`:
  finds a new message with exact sender, recipient and subject matches.
- `emailContent(message)`: parses text and HTML links without executing HTML.
- `emailEvidence(message, expectedText)`: emits receipt metadata and deterministic
  passage-presence assertions, omitting raw bodies, headers, links and codes.

Watch cursors can be passed as retained file evidence to dependent command
collectors. Use a unique subject or dedicated inbox for every concurrent action.
The adapter paginates up to 1,000 messages and includes spam, blocked,
unauthenticated and trashed messages in observation. Categories are preserved as
labels; a suite can explicitly reject spam delivery. Normal arrival is not proof
of inbox placement or rendering in Gmail, Outlook or other clients. Receipt
assertions are project-supplied instrumented checks, not independent LLM findings.
Raw bodies and attachments are not automatically retained or inspected.

Existing message IDs and messages received before the watch started are excluded.
Receive-time comparison allows subsecond rounding for whole-second API timestamps;
the ID cursor and unique action matcher establish the correlation boundary.
More than one new matching message is an actionable ambiguity error; no arbitrary
"latest email" is chosen. The client polls by default, so no public webhook endpoint
is necessary. Waits are bounded (up to 300 seconds); each API request has a separate
15-second timeout and a 2 MiB response limit. A final in-flight request can extend
the time required to finish inspection, including pagination and message fetching.
Messages received after the observation deadline cannot satisfy the check.
API redirects are rejected, and API errors never include
response bodies or credential-bearing URLs in diagnostics.

`null` from `waitForEmail` means a healthy observation window found no matching
message. A grader may fail a delivery requirement when the send was exercised and
that requirement specifies the observation window. A blocked send or unavailable
observation reduces coverage. HTTP failures, malformed responses, ambiguous
matching/extraction and invalid selector syntax are execution errors. An email
login that receives no message, times out reaching an app control, or cannot verify
the identity is blocked, and cannot continue exploring a logged-out app.

AgentMail references: [list messages](https://docs.agentmail.to/api-reference/inboxes/messages/list),
[get message](https://docs.agentmail.to/api-reference/inboxes/messages/get),
[message categories](https://docs.agentmail.to/webhooks-overview).
