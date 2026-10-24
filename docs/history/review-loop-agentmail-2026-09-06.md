# AgentMail review/fix loop — 2026-09-06

Completed nine review rounds. The latest review reports no actionable findings.
All ten findings from rounds 1–8 were addressed, including one test adjustment for
the intentional terminal-finalization contract. Final validation passed all 420
tests, type checking, build, lint, formatting, whitespace checks and the
production-package smoke on Node 20.19.0.

Every round uses the requested command against the full uncommitted change set:

```sh
codex exec review --uncommitted -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

Full reviewer output and check logs are retained locally in
`/tmp/aek-agentmail-review-loop-20260906-rRDrMs/`. The findings and decisions below
are retained in the repository. Reviewer output repeats the final findings; each
distinct finding is recorded once.

## Round 1

Command exited 0. Raw output: `round-1.log`. The reviewer ran type checking and
68 targeted tests; all passed. It reported two P2 findings:

1. **Preserve string redaction for email declarations** (`src/config.ts`,
   originally lines 423–424). The review said restoring the original `emailAuth`
   declarations bypassed string redaction and could retain an environment-expanded
   token in resolved configuration snapshots.

   **Decision: actionable, with a correction to the example.** The suggested
   `/login?token=…` start path already fails `loadConfig`'s credential-bearing URL
   validation, so that specific reproduction is a false positive. However, a
   valid environment-expanded `emailSelector` containing `data-token="…"` does
   bypass redaction. A regression reproduced the leak through real config loading.

   **Fix:** preserve declaration keys, persona/mailbox names, API-key environment
   variable names and credential extraction rules, while applying existing string
   redaction to all declaration leaf values. Existing URL rejection stays in
   place. No fallback or compatibility layer was added.

2. **Align the Node engine floor with the parser dependency** (`package.json`,
   originally line 49). `parse5` resolves to `entities@8.0.0`, whose installed
   package manifest requires Node >=20.19.0; AEK advertised >=20.12.0.

   **Decision: actionable.** Engine-enforcing installs on Node 20.12–20.18 would
   reject the dependency despite satisfying AEK's advertised requirement.

   **Fix:** raise the minimum to Node 20.19.0 in the package, doctor check, CI
   matrix and current setup documentation. Historical validation records retain
   the versions actually used. Keeping the current parser and declaring its
   requirement is clearer than adding dependency compatibility support.

Both new regression assertions failed before their respective fixes. All 30
config/spec and doctor tests passed afterward, including the existing start-path
rejection and preservation of declaration structure. Type checking, lint,
formatting and whitespace checks passed. Production-package smoke, including the
build and installed email workflows, passed using Node 20.19.0.

The first full `pnpm test` run passed 413/414 tests; the existing redirect
containment test observed one external key event under concurrent browser load.
Its isolated rerun passed without changes. A full rerun with test concurrency
limited to four is recorded separately; the first failure is retained in
`round-1-full-tests.log` and the isolated result in `round-1-origin-recheck.log`.
The full rerun passed all 414 tests (`round-1-full-tests-recheck.log`). The round-2
reviewer independently reran the redirect test successfully. No speculative
production change or weakened assertion was made for this intermittent failure.

## Round 2

Command exited 0. Raw output: `round-2.log`. The reviewer reported two P2 findings:

1. **Keep secret-bearing login declarations outside retained evidence**
   (`src/scenario.ts`, originally lines 224–227). The raw login flow was embedded
   in retained `browser-context.json`, bypassing resolved-config redaction.

   **Decision: actionable, distinct from round 1.** This is a separate retention
   path. A regression reproduced the selector secret in the browser context even
   after execution failed and the private key file was removed.

   **Fix:** transfer the entire login/mailbox declaration alongside the API key
   through the existing one-use private file. The retained context contains only
   its file reference. The MCP validates the complete payload strictly and removes
   it before authentication; runner cleanup also covers failures and unconsumed
   files. No legacy payload fallback is accepted.

2. **Wait for the expected identity text before rejecting login**
   (`src/email/authenticate.ts`, originally lines 122–126). An already-visible
   account label can still display `Loading...`; the single text comparison
   blocked login before the real account text arrived.

   **Decision: actionable.** A real browser fixture reproduced this with an
   800 ms identity update within a 3-second browser action timeout.

   **Fix:** wait within the browser action timeout for a visible selector with
   exactly matching trimmed text. Polling retains origin checks. Persistent
   mismatch remains blocked, while malformed selectors and inspection failures
   remain execution errors; the comparison is not relaxed.

Both regressions failed before their fixes (`round-2-regression-before.log`).
All 91 focused email, browser evidence/MCP, scenario, config/spec and doctor tests
passed (`round-2-targeted.log`), along with type checking, lint, formatting and
whitespace checks. These checks include persistent identity mismatch, malformed
selector errors, private-file cleanup, and successful link/code authentication.
Production-package smoke passed again on Node 20.19.0, including the build.
The subsequent full run passed all 415 tests (`round-2-full-tests.log`).

## Round 3

Command exited 0. Raw output: `round-3.log`. Type checking and the reviewer's 55
targeted tests passed. It reported one P2 finding:

1. **Make email declaration redaction idempotent** (`src/config.ts`, originally
   lines 428–430). Removing quotes around a redacted selector value meant the
   next redaction consumed its closing bracket. A sealed collection therefore
   failed its configuration fingerprint check when loaded for offline judging.

   **Decision: actionable.** This is a regression exposed by applying existing
   string redaction to email declarations. A test using `sealCollection`,
   `loadResolvedConfig` and `assertCollectionCompatible` reproduced rejection of
   an unchanged collection (`round-3-regression-before.log`).

   **Fix:** retain the original quote delimiters around redacted values, so
   repeated redaction preserves adjacent syntax and the collection fingerprint.
   The regression covers double-quoted, single-quoted and unquoted selector
   values, confirms secrets remain absent, and checks the sealed-config round
   trip. No fingerprint bypass or compatibility fallback was introduced.

All 27 config/spec tests passed after the fix (`round-3-config-tests.log`), along
with type checking. Build, lint, formatting and whitespace checks passed, and
the full suite passed all 415 tests (`round-3-full-tests.log`).

## Round 4

Command exited 0. Raw output: `round-4.log`. Type checking and the reviewer's 96
targeted tests passed. It reported one P2 finding:

1. **Preserve block boundaries when extracting email text**
   (`src/email/mailbox.ts`, originally lines 239–241). HTML such as
   `<h1>739182</h1><p>Expires soon</p>` became `739182Expires soon`, causing the
   verification-code boundary check to reject a valid code.

   **Decision: actionable.** Both text extraction and the real MCP code-login
   fixture reproduced the failure (`round-4-regression-before.log`). Headings
   containing an OTP are a normal email template pattern.

   **Fix:** preserve boundaries before and after block elements, including
   headings and table cells, while keeping inline text contiguous. HTML remains
   inert; code matching still requires exactly one distinct bounded code. Tests
   cover headings, text surrounding blocks, tables, section boundaries and codes
   split across inline elements; the real login fixture uses the reported HTML.

All 12 email tests passed after the fix (`round-4-email-tests.log`), along with
type checking. Production-package smoke passed on Node 20.19.0, including the
build (`round-4-node20-package.log`). Lint, formatting and whitespace checks passed.

## Round 5

Command exited 0. Raw output: `round-5.log`. Type checking and the reviewer's 96
targeted tests passed. It reported one P2 finding:

1. **Persist credential blocks immediately** (`src/browser/mcp.ts`, originally
   lines 115–117). A credential rejection after a previous `done` call changed
   only in-memory state, leaving a completed result and storage candidate that
   could still be accepted and promoted.

   **Decision: actionable.** The reviewer reproduced this through the real MCP.
   Our regression also confirmed that browser actions remained executable after
   finalization (`round-5-regression-before.log`).

   **Fix:** choose the reviewer's alternative of prohibiting all further browser
   actions after successful finalization. The serialized common tool boundary
   rejects subsequent calls, including screenshots, snapshots, observations,
   navigation and repeated `done`, before touching the browser or published
   evidence. This makes finalization terminal instead of maintaining mutable
   results and revoking previously captured state piecemeal. Rejected calls are
   retained as errors in the transcript. Failed finalization still reports its
   execution error and cannot claim success.

   **Coverage:** verify that late calls fail and cannot replace the result or
   screenshot metadata. The expiry test now runs before finalization in a
   separate login scenario and still requires a blocked outcome, no candidate
   session and no leaked credential; successful link/code session saving remains
   covered independently.

All 62 focused browser MCP/evidence, email and scenario tests passed
(`round-5-targeted.log`), along with type checking. Build, lint, formatting,
whitespace checks and Node 20.19.0 production-package smoke passed. The full run
passed 415/416 tests, exposing the outdated persona test addressed in round 6.

## Round 6

Command exited 0. Raw output: `round-6.log`. Type checking passed; the reviewer's
full suite also passed 415/416 tests. It reported one P2 finding:

1. **Update the persona-switch test for terminal finalization**
   (`src/browser/mcp.ts`, originally lines 312–313). The existing persona test
   tried to switch to a missing persona after `done` and expected another `done`
   to replace its result with blocked. The new terminal guard correctly rejected
   that sequence, but the unchanged test failed CI.

   **Decision: actionable test regression.** Both independent full runs failed
   the same assertion (`round-5-full-tests.log` and the reviewer's output).

   **Fix:** exercise missing-persona blocking in a fresh, unfinished MCP session,
   still requiring a blocked result and no saved candidate. The original test
   separately verifies that a late persona switch is rejected and cannot alter
   its completed result. The intentional production finalization guard remains.

All four persona tests passed (`round-6-persona-tests.log`), along with type
checking, formatting and whitespace checks. Both the parent full run
(`round-6-full-tests.log`) and the next reviewer's full run passed all 417 tests.

## Round 7

Command exited 0. Raw output: `round-7.log`. Type checking and all 417 tests
passed. It reported one P2 finding:

1. **Check DOM text as well as markup for authentication credentials**
   (`src/browser/session.ts`, originally lines 117–119). Formatting a consumed
   code as `<span>739</span><b>182</b>` prevents raw HTML from containing the
   contiguous code, even though a screenshot displays it.

   **Decision: actionable.** The reviewer reproduced successful finalization and
   screenshot persistence. A new regression also failed before the fix
   (`round-7-regression-before.log`).

   **Fix:** inspect decoded DOM text as well as markup, including open shadow
   roots, and inspect the document's rendered text. Existing URL, input-value,
   frame and background-tab checks remain in force. Inspection errors still
   propagate; there is no fallback that permits capture after a failed check.

   **Coverage:** formatted, entity-encoded codes in ordinary DOM and shadow roots
   must block both authentication finalization and later snapshots/screenshots.
   Clearing the credential permits finalization. No unsafe screenshot is retained.

All 53 focused email and browser MCP/evidence tests passed
(`round-7-targeted.log`), along with type checking, build, lint, formatting and
whitespace checks. The subsequent full run passed all 418 tests
(`round-7-full-tests.log`).

## Round 8

Command exited 0. Raw output: `round-8.log`. Type checking and the reviewer's 90
targeted tests passed. It reported one P2 finding:

1. **Exclude surrounding punctuation from plaintext login URLs**
   (`src/email/mailbox.ts`, originally line 293). A link written as
   `Sign in (https://app.test/auth/verify?token=abc123).` included `).` in the
   extracted token. The plain-text login failed, and a multipart message with
   the correct HTML anchor was incorrectly considered ambiguous.

   **Decision: actionable.** Text extraction and real plain-text/multipart MCP
   login cases all failed before the fix (`round-8-regression-before.log`).

   **Fix:** recognize surrounding prose punctuation and unmatched closing
   brackets before deduplication. Keep balanced parentheses, encoded characters,
   and explicitly angle-bracketed/quoted URL contents intact. HTML anchors remain
   exact attribute values. Different actual URLs still trigger ambiguity errors;
   there is no fallback to arbitrarily choose a credential.

   **Coverage:** plain text, multipart representations, Markdown-style wrapping,
   balanced parentheses, typographic quotes, percent encoding and literal trailing
   punctuation inside explicit delimiters. Real login cases also check private
   artifact cleanup and absence of credentials in evidence.

All 16 email tests passed (`round-8-email-tests.log`), along with type checking,
build, lint, formatting and whitespace checks. The final full-suite run passed
all 420 tests (`round-8-full-tests.log`), and production-package smoke passed on
Node 20.19.0 (`round-8-node20-package.log`), including the build and installed email
collector/checker pass and failure cases.

## Round 9 — no actionable findings

Command exited 0. Raw output: `round-9.log`. The final review states:

> No actionable regressions were identified in the staged, unstaged, or untracked
> changes. Type checking and all 92 targeted tests passed.

**Decision:** no further implementation changes required. The loop is complete.

## Non-actionable observations and validation limits

- Round 1's specific `/login?token=…` example was already rejected by config
  loading. Its broader redaction finding was actionable and fixed using a valid
  selector reproduction. No complete finding was dismissed as style-only,
  unrealistic or a false positive.
- Repeated copies of each final review comment in CLI output were recorded once;
  they were duplicate output, not additional issues.
- The first full run's intermittent redirect-containment assertion was retained
  and investigated. Isolated, reviewer and subsequent full reruns passed without
  weakening the assertion. The round-6 persona failure was deterministic and was
  corrected explicitly; final full validation passed all 420 tests.
- Mailbox and application checks used local integration fixtures; no live
  AgentMail inbox was exercised. The requested Codex review calls used the real
  CLI; evaluation-provider tests used fixtures or mock providers.

Changes remain uncommitted.
