# Authentication

Authenticated web scenarios use browser sessions captured ahead of time. AEK
does not accept application passwords in configuration.

## Capture a browser session

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

To switch between several saved personas inside one scenario, see
[switching saved personas](workflows.md#switching-saved-personas).

## Email links and codes

For AgentMail-backed magic links and emailed verification codes, declare an
`emailAuth` flow and run `aek auth --persona buyer --email`. Scenarios can also
exercise the login journey with `authenticateEmail: true`. The packaged mailbox
helper supports command collectors that verify notification delivery and content.
`provider: mailpit` supports local capture in `emailAuth`; `createMailpitMailbox`
also exposes the same recipient-scoped observation helpers for command collectors.
See [email evidence and authentication](email.md) for configuration, examples,
credential handling and supported flow boundaries, and the
[mailbox and email-auth fields](configuration.md#mailboxes-and-email-authentication).
