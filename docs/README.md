# AEK documentation

AEK evaluates a project against your scenarios and weighted rubric, retaining the
evidence behind each result. Begin with one measurable requirement, verify that
the evaluation detects a deliberate defect, then expand the suite.

## Start here

1. [Install AEK](../README.md#built-package-distribution), or use the
   [source checkout](../README.md#quick-start).
2. [Run your first evaluation](first-run.md): an offline cart example with known
   scores, coverage, a failed critical gate, and a before/after comparison.
   This walkthrough requires the source checkout.
3. [Onboard your project](onboarding.md): select a starter, define evidence,
   prepare test state, calibrate a check, and promote a reviewed run.

The guides write `aek` for the CLI. Use `npx aek` with a local npm installation or
`pnpm exec aek` with a local pnpm installation. `pnpm aek` invokes the development
script in this repository. Examples with `<run-id>` or `/path/to/...` require you
to substitute your actual paths.

For guided whole-project setup, use [project authoring](authoring.md): the agent
surveys your project, interviews you about expectations, and writes a persistent
evaluation map and executable suite.

## Choose an evaluation workflow

Read [evaluation types and boundaries](evaluation-types.md) for a side-by-side
guide to user stories, image and text comparisons, rubric grading, deterministic
checks, and file/integration workflows, including a user-story YAML example.

| What you want to evaluate | Guide |
| --- | --- |
| Web behavior, repository contracts, or command output | [Configuration and specs](../README.md#configuration), [grader types](../README.md#grader-types) |
| Authenticated flows or workflows spanning scenarios | [Authentication](../README.md#authentication), [dependencies, bindings, and personas](workflows.md) |
| Writing, voice, factual fidelity, or datasets of related texts | [Text evaluation](text-evaluation.md), [packaged dataset example](../examples/text-datasets/README.md) |
| Two existing image files | [Direct image comparison](image-comparison.md) |
| Screenshots, motion, visual regressions, or exported images | [Visual evaluation](visual-evaluation.md) |
| Downloaded files, command-produced artifacts, or checkpoints | [File evidence and evaluation scope](file-evidence.md) |
| Magic links, verification codes, or notification delivery | [Email evidence and authentication](email.md) |
| Several judging methods over the same collected evidence | [Separate collection and judging](evidence-workflows.md) |

## Operate and review evaluations

| Task | Guide |
| --- | --- |
| Look up configuration fields, defaults, limits, and precedence | [Configuration reference](configuration.md) |
| Find commands, selection flags, defaults, and exit statuses | [Command guide](cli.md) |
| Diagnose setup failures, blocked scenarios, or low coverage | [Troubleshooting](troubleshooting.md) |
| Interpret score, coverage, and critical gates | [Read the first report](first-run.md#read-the-report) |
| Resume a run, adjust scoring, or complete manual checks | [Run recovery and manual finalization](../README.md#run-resume-rescore-finalize) |
| Resolve an automatic abstention with human evidence | [Adjudication](adjudication.md) |
| Enforce CI acceptance criteria | [CI thresholds](../README.md#ci-thresholds), [exit statuses](cli.md#exit-statuses) |
| Compare versions or assess repeated-run stability | [Run comparisons](../README.md#compare-runs), [campaigns](../README.md#repeated-run-campaigns) |
| Promote an accepted release or record an incomplete milestone | [Promotion policies](evidence-workflows.md#baseline-promotion-policy) |
| Share results without raw private evidence | [Public export and privacy lint](../README.md#public-export-and-privacy-lint) |

## Project and maintainer references

[Development commands](../README.md#development), [judging contracts](judging-contracts.md),
[internal boundaries](internal-boundaries.md), and [release validation](release-validation.md)
describe implementation and verification. Dated `review-loop` documents in this
directory are historical engineering records; use the task guides above for
current workflows.
