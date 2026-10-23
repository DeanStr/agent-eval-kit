# Bounded project improvement

`aek improve` gives a coding agent an evaluation loop: establish a baseline, record
a hypothesis, edit a candidate, run the full suite, and keep or restore the result.
AEK owns the checkpoints and acceptance decision; the coding agent supplies edits.
It does not launch another coding agent or require a particular provider.

Install the optional skill with `aek improve install`, then ask your coding agent
to use `$aek-improve` for a specific objective. Installation defaults to
`.agents/skills/aek-improve`, includes its own instructions, and refuses to overwrite
an existing skill. Commit the installation if it lives in the project before starting.

## Prepare the acceptance suite

Use a deterministic, executable acceptance suite that measures the improvement
objective and protects existing requirements. This version compares one baseline
run with one run per candidate and allows no item or case regression. It has no
repeated-run acceptance protocol or noise tolerance. LLM judges and other noisy
checks can reject useful candidates or retain a lucky run as best; calibration
alone does not remove that limitation. Use independent repeated evaluation for
claims about noisy performance outside this strict loop.

The objective text is a record of intent; it does not alter the rubric or become
judge instructions.

- Use a clean Git checkout with the intended product and evaluator files committed.
  AEK never stashes unrelated edits. `project.root` must equal the repository root;
  config and resource paths must resolve inside the candidate checkout.
- Declare command-checker and collector dependencies in `methodFiles`. The config,
  specs, datasets, references, fixtures, declared evaluator code, and Git ignore/
  attribute files are frozen. They must be tracked files inside the checkout.
  Product candidate files remain editable. Fix an evaluator in a new session.
- Use automatic graders. Manual and hybrid review cannot be resolved by this loop.
- Configure `target.setup` for dependencies and `target.start` for services. Web
  evaluation requires a session-owned service, with external-server reuse disabled.
  Build outputs and installed dependencies must be ignored; tracked source must
  remain unchanged during evaluation. The new worktree has no copied `node_modules`.
- Git submodules and embedded repositories are rejected before checkpointing or
  evaluation; vendor their files as regular tracked files instead.
  Keep authentication and other local runtime
  setup available within the candidate workspace as needed; credentials are not
  copied automatically. Retained evidence has the same privacy considerations as
  ordinary AEK runs.

Every baseline and attempt runs **all areas, optional areas, and all splits** in
the chosen named suite. There is no per-attempt area, scenario, or changed-case
shortcut. Repeatedly inspected evaluation cases are no longer an untouched
holdout; use a separately governed suite for a later generalization check.

## Run a session

The output must be a new directory outside the source repository. All candidate
edits go into the detached `workspace` worktree created there. The source checkout
and branch remain unchanged.

```sh
aek improve start --config evalkit.yaml --goal 'Improve task success without regressions' \
  --output ../project-improvement --max-attempts 3 --max-stalls 2 \
  --budget-seconds 3600 --minimum-gain 0 --json

aek improve attempt --session ../project-improvement \
  --hypothesis 'Handle the missing empty-input case identified by the baseline' --json

# Edit ../project-improvement/workspace, then evaluate it:
aek improve evaluate --session ../project-improvement --json
aek improve status --session ../project-improvement --json
```

Use `--suite name` on `start` to select an existing named suite. Session settings
are fixed at creation: default three candidate attempts, two consecutive
attempts without improvement (including inconclusive and execution-error attempts),
and a one-hour wall-clock budget including editing. New attempts check
the deadline; active evaluations are cancelled when it expires. Editing is
external to AEK, so an idle editor is not terminated by the deadline. An
evaluation cancelled or refused by the deadline records the attempt as `stopped`
with `budget_exhausted` and exits 2; it is a budget stop, not an execution error,
and the candidate is retained without a score.

Each attempt is registered before editing and consumes one attempt slot. Do not
commit or switch branches in the owned workspace. AEK captures tracked changes,
deletions, and nonignored new files with a private index, preserving a candidate
commit even when rejected. Do not edit concurrently with evaluation.

To stop early, retain unfinished edits and restore the best checkpoint:

```sh
aek improve stop --session ../project-improvement \
  --reason 'No further useful hypothesis within the requested scope' --json
```

Optional UTF-8 repair notes can be retained with `evaluate --guidance notes.txt`
(maximum 64 KiB). Save them outside the candidate checkout. Notes and hypotheses
are audit context, not inputs to acceptance judges. The acceptance run uses fresh
collection/judging through the existing runner and its frozen evaluation method.

## Acceptance and stopping

A candidate replaces the best checkpoint only when:

1. The complete evaluation succeeds with compatible evaluator fingerprints and
   intact report/evidence artifacts.
2. Every area has 100% evidence coverage and the score is available. Required
   scenarios were exercised.
3. No comparable rubric item or dataset/template case regresses, loses coverage,
   or disappears, including optional areas. This prevents an aggregate gain from
   hiding a local regression.
4. The overall rubric score strictly increases and meets `--minimum-gain` in
   percentage points. The default zero still rejects ties. The overall score uses
   AEK's normal area aggregation; optional areas remain protected by comparison.

Acceptance uses full-precision weights. Display rounding cannot hide missing
coverage or round a gain up to the minimum; `attempt.scoreGain` records the
unrounded difference for a fully measured, compatible candidate.

The initial baseline may contain measured failures. `best.accepted: false` means
no improvement has yet passed acceptance; it is not a release approval of that
baseline. Previously failing critical gates may remain failed, and incremental
improvements may remain below `promotion.minimumScore`. Previously passing gates
are protected by the no-regression rule. Even `best.accepted: true` records an
improvement, not release approval: release promotion still requires passing gates
and its configured score threshold. After acceptance, each candidate is compared
against the latest best.

| Result | Meaning and action |
| --- | --- |
| `accepted` | Keep the candidate as best; continue if budget permits. |
| `rejected` | Measured acceptance failure; retain evidence and restore best. |
| `inconclusive` | Missing evidence, including blocked or agent-error scenarios; retain diagnostics, restore best, and continue within the original budgets. |
| `execution_error` | Candidate execution failed; retain diagnostics without an acceptance score and restore best. Another attempt is permitted only if source, evaluator, retained artifacts, and restoration remain valid. |
| `stopped` | User interruption, explicit stop, or time budget expiry; retain the candidate and restore best when ownership is intact. |

An initial baseline with insufficient evidence stops the session because there is
no fully measured reference. A candidate with insufficient evidence consumes an
attempt without replacing that reference. Execution errors still return exit 1;
continuation requires a new explicit attempt, not an automatic retry. Evaluator
changes, corrupted retained artifacts, ownership changes, and failed restoration
stop the session with `execution_error`. Process cleanup failures also stop the
session and leave the workspace for inspection before any restoration.

Session stop reasons are `attempt_limit`, `no_improvement` (consecutive attempts
without improvement), `budget_exhausted`, `insufficient_evidence`, `execution_error`, and `user_stopped`.
An accepted final attempt can also stop at the attempt limit. A score ceiling or
plateau is not permission to relax requirements. A minimum gain is an effect-size
threshold, not a statistical confidence guarantee. SIGINT and SIGTERM stop the
session with `user_stopped` and exit 130/143, including during baseline evaluation.

## Review artifacts and recovery

The session directory contains:

```text
session.json                         # settings, state, best checkpoint, attempt history
workspace/                           # owned detached Git worktree
runs/<run-id>/                       # ordinary sealed AEK runs and reports
attempts/<n>/decision.json            # hypothesis, decision, reasons, checkpoint, run
attempts/<n>/comparison/              # JSON and HTML comparison against the prior best
process-groups.json                  # owned process groups; empty after successful cleanup
```

Paths inside `session.json` are relative to its directory except the source and
Git ownership metadata. Accepted and rejected commits are retained under
`refs/aek/improvements/<session-id>/`; failed evaluation writes can have an
additional recovery checkpoint. `stoppedCheckpoint` records the commit retained
by `stop`, including edits made without an open attempt. Ignored dependencies,
credentials, and generated files survive source restoration. Reset mutable test data with your normal target
setup: Git restoration does not roll back databases, services, or ignored files.

Mutating commands acquire a session lock. A crash can leave an active attempt or
stale lock. Stop any surviving workers and inspect the retained state before
manual recovery; stale locks are not reclaimed automatically. The loop does not
resume a partially completed evaluation. After a candidate execution failure,
inspect its diagnostics and session status before choosing a new hypothesis. A
`ready` session permits another attempt within its original limits; a `stopped`
session does not. If ownership changes (for example, the workspace is attached to
a branch), AEK refuses restoration
rather than moving that branch. The error identifies the retained workspace for
review. Keep session files intact; they are local workflow state, not a security
boundary against an adversarial coding agent.

Review all accepted changes with `git diff <initial> <best.checkpoint>`. If the
source branch is still at the initial commit, explicitly applying the result with
`git merge --ff-only <best.checkpoint>` includes all accepted steps. AEK never
applies the result to the original checkout automatically. Keep the session until
its evidence and rejected candidates are no longer needed. For a stopped session
with no remaining session lock or live owned workers, `status` lists the exact
`cleanup` commands: they remove the workspace worktree and
the session's `refs/aek/improvements/<session-id>/` refs from the source repository.
Otherwise, `cleanupBlockedReason` explains what must be resolved before cleanup;
stop surviving workers and rerun `status` before deleting the workspace or session.
AEK never runs them; delete the session directory yourself afterwards. Removing the
refs discards rejected candidates and, unless already applied, the best checkpoint.

All commands support `--json`, using the normal AEK result envelope with progress
on stderr. Exit 0 means success (`evaluate`: accepted); exit 2 means rejected,
inconclusive, time budget exhausted, or no new attempt permitted. Exit 1 means input/execution failure;
130/143 mean interruption. `status` and `stop` return 0 for successful inspection
or stopping even if the session recorded a failure. Error JSON includes
`context.sessionDir` so automation can inspect retained diagnostics.
Failures recorded by baseline or candidate evaluation also include
`context.session` with the final saved `status`, `stopReason`, and `attemptStatus`.
The latter two fields are `null` when no stop reason or attempt exists. A `ready`
session permits another explicit attempt within its original budgets; a `stopped`
session does not, including when an otherwise recoverable failure used the last
attempt or stall slot. These execution failures still exit 1 and keep `result: null`.
Preflight errors may omit the session summary because no final state was recorded.
Further attempt requests return a stopped session with exit 2; sessions stopped
by execution errors continue to return exit 1.
