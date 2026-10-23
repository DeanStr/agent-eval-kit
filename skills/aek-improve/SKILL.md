---
name: aek-improve
description: Improve a project through bounded AEK evaluation attempts, preserving the best accepted Git checkpoint and restoring rejected candidates. Use when asked to iteratively improve an existing project against an executable Agent Eval Kit suite.
---

# AEK improvement

Use the installed `aek improve` CLI to own checkpoints, evaluation, comparison, and restoration. You supply the hypothesis and product edits. The suite supplies acceptance criteria; repair advice does not authorize acceptance.

## Establish the session

Use the project's existing AEK configuration and the user's improvement objective. Inspect the rubric before starting: it must measure that objective and protect behavior that should survive the edit. Use deterministic acceptance checks for this version: it compares single runs with zero item/case regression tolerance, with no repeated-run acceptance protocol. Noisy judges can reject useful changes or select lucky runs; calibration alone does not make this loop statistically reliable. If the suite needs changes, finish and validate those before creating the session. Do not weaken the evaluator to make a candidate pass.

`start` requires a clean committed Git repository, a tracked config with portable relative paths, and `project.root` at the Git root. Respect existing user work; do not stash, discard, or commit unrelated changes to satisfy this requirement. Command checkers and collectors must declare their evaluator code in `methodFiles`. Manual/hybrid graders require a separate workflow. Dependencies and test services should be prepared by `target.setup`/`target.start`; generated files must be ignored.

Choose a new session directory outside the repository. Use the user's attempt and time limits when provided; defaults are three attempts, two consecutive attempts without improvement (including inconclusive and execution-error attempts), and one hour including editing. All splits and optional areas are evaluated on every attempt. A suite used this way is an optimization suite, not an untouched holdout.

```sh
aek improve start --config evalkit.yaml --goal 'Improve the specified behavior' \
  --output /path/outside/repository/improvement --max-attempts 3 \
  --max-stalls 2 --budget-seconds 3600 --json
```

Read the returned `workspace`, `best.run.directory`, and `pinnedFiles`. Run paths are relative to the session directory. Read the baseline report and evidence before choosing an edit. If the session stopped, report its reason; missing evidence is not a low quality score.

## Make bounded attempts

1. Record a concrete hypothesis before editing:
   `aek improve attempt --session /path/to/session --hypothesis 'Change X because evidence Y predicts improvement Z' --json`.
2. If the command permits an attempt, edit only the returned candidate workspace. Keep the user's scope and constraints. Do not commit, switch branches, edit frozen inputs, or edit while evaluation runs. AEK owns this checkout and may restore it after rejection.
3. Use baseline evidence and ordinary development checks to repair the product. Optional review notes can be saved outside the workspace and passed with `--guidance`; they are retained for explanation and never fed into acceptance judges. Do not treat an advisor's approval as a pass.
4. Run `aek improve evaluate --session /path/to/session --json`. This checkpoints the candidate and runs a fresh full evaluation. An accepted candidate needs a strictly higher score, no item or dataset/template case regression, complete evidence, and exercised scenarios. Previously passing critical gates must stay passed; existing gate failures and scores below the release minimum may improve incrementally. Accepted improvement is not release approval. A tie is rejected. Read the decision and comparison, including reasons for rejection.
5. If still ready, choose another evidence-supported hypothesis within the remaining budget. Otherwise stop. If no useful hypothesis remains, use `aek improve stop --session /path/to/session --reason 'Explain why further attempts would not help' --json`.

Exit 2 means rejection, insufficient evidence, or no new attempt permitted; parse its JSON rather than treating it as an execution crash. Exit 1 means an input/execution error: inspect the recorded session and run diagnostics. An inconclusive or candidate execution-error attempt restores best and may leave the session ready for a new hypothesis within its original budgets. Do not automatically retry, repeatedly rerun the same failure, or change the evaluator. Evaluator/integrity/ownership/restoration failures stop the session. SIGINT/SIGTERM record user_stopped and exit 130/143. `aek improve status --session ... --json` shows the retained state. After a process crash or ownership error, inspect the worktree and active workers before recovery; do not bypass a stale lock automatically.

The CLI restores the best checkpoint after rejection or a handled evaluation failure when ownership and process cleanup remain valid. Failed process cleanup stops the session and leaves the workspace for inspection before restoration. The initial baseline has `best.accepted: false` until an improvement is accepted. Stop when the CLI stops; do not start another session just to evade its limits. A score ceiling or plateau is a valid outcome.

## Return the result

Report accepted improvements, rejected hypotheses, evidence/coverage limitations, and the stop reason. Include the session directory, best checkpoint, and report/comparison paths. Keep the result in its worktree unless the user's request authorizes applying it to another checkout. Review the cumulative patch with `git diff <initial> <best.checkpoint>`; multiple accepted checkpoints may contribute to it. Do not claim a statistical confidence level or a globally optimal result from this bounded local search.
