# Choose an evaluation type

Start with the question you want answered. AEK combines an evidence source
(browser, workspace inspection, command-produced artifacts, or direct text)
with a grader (model judgement, deterministic check, human review, or a hybrid).
The use cases below are combinations of those capabilities, not separate products.

## Supported use cases

| Your question | How to configure it | Guide or example |
| --- | --- | --- |
| Can a user complete this story or job? | Browser scenario instructions plus rubric acceptance criteria, usually with an independent `llm` judge. | [Story example below](#turn-a-user-story-into-an-evaluation), [multi-step workflows](workflows.md) |
| Does the code match its documented contract? | A `workspace` scenario collects source evidence for an `llm` rubric. | [Repository starter](onboarding.md#choose-a-starter), [repository example](../examples/repository/specs/quality.yaml) |
| Does a command produce the expected result? | A `command` grader executes your checker and reads an explicit JSON or exit-code result. | [Grader contract](graders.md#command), [offline walkthrough](first-run.md) |
| Is this image preferable to, or at least as good as, a reference? | Use `aek image compare` for two files, or a `pairwise` rubric for collected images. | [Two-file comparison](image-comparison.md), [blind image grading](visual-evaluation.md#blind-pairwise-grading) |
| Does this image satisfy an absolute requirement? | Collect the image and use an ordinary `llm` rubric, such as a readability gate. | [Absolute image quality](visual-evaluation.md#absolute-quality-and-relative-preference), [chart example](../examples/artifact/specs/chart.yaml) |
| Is rendering reproducible, sufficiently different, or within measured bounds? | Use `capture`, `image-distinctness`, or `image-regression` checks. | [Controlled capture](visual-evaluation.md#controlled-browser-capture), [image health](visual-evaluation.md#image-health), [distinctness](visual-evaluation.md#scoped-image-distinctness), [baseline statistics](visual-evaluation.md#image-statistic-baseline-checks) |
| Which text is better, or closer to a desired voice? | A `text-pairwise` rubric reads candidate and reference text directly, with an optional fixed style target. | [Text comparison](text-evaluation.md), [target voice](text-evaluation.md#a-fixed-target-voice) |
| Does this text meet criteria or preserve supplied facts? | A `text-rubric` reads one or more named inputs and optional reference material. | [Direct text rubric](text-evaluation.md#direct-rubric-grading), [grouped text datasets](text-evaluation.md#datasets-grouped-cases-and-reusable-templates) |
| Is an exported or downloaded file correct? | Browser download or command collection, followed by a project-owned file checker. | [File checks](file-evidence.md#deterministic-file-checks), [file example](../examples/files/evalkit.yaml) |
| Does an email or cross-persona workflow work? | Authentication/mailbox integration and scenario dependencies, with model or command checks on observed evidence. | [Email](email.md), [workflow bindings and personas](workflows.md) |

For two existing images, [direct image comparison](image-comparison.md) generates
the collection and judging setup automatically. Add `--absolute-criterion` for a
separate candidate-only quality gate. Direct text graders need no collection scenario.

Use `manual` for declared human checks or `hybrid` for weighted automatic and
human shares. See [grader types](graders.md) and
[finalization](runs.md#finalize-manual-checks). Human
[adjudication](adjudication.md) is a separate way to resolve eligible automatic
abstentions after reviewing evidence.

## Turn a user story into an evaluation

For the story “As a buyer, I want my cart to survive a reload,” define the action,
expected result, and evidence explicitly. Run `aek init --kind web`, configure
your target URL, and replace `evals/specs/core.yaml` with a project-specific area
like this:

```yaml
id: cart
title: Cart persistence
weight: 100
description: A buyer can retain the intended quantity and subtotal after reload.
scenarios:
  - id: CART-RELOAD
    name: Change quantity and reload
    kind: browser
    instructions: |
      Open the storefront and add the test product priced at 5.00.
      Set its quantity to two. Capture the cart, reload the page,
      and capture the resulting quantity and item subtotal.
    successSignals:
      - Quantity remains two and the item subtotal remains 10.00 after reload.
rubric:
  - id: CART-PERSISTENCE
    criterion: Cart quantity and item subtotal persist across reload.
    weight: 1
    gate: true
    scenarios: [CART-RELOAD]
    grader: { type: llm }
    passCriteria: After reload, quantity is two and the item subtotal is 10.00.
    evidence: Before/after screenshots and recorded reload interaction.
```

Replace the product and values with your fixtures and provide the required test
state. Add authentication/persona settings if the workflow requires a login.
Then validate and pilot the evaluation using the [onboarding guide](onboarding.md).
This YAML is an example definition; it cannot evaluate an unconfigured storefront.

For a guided interview that generates these files across the whole project, use
the [authoring skill](authoring.md).

The scenario tells the collector what to exercise. The rubric tells the
independent judge what evidence establishes success. The authoring skill asks about missing expectations before generating a complete
evaluation definition; a pasted story alone rarely settles the contract. For exact arithmetic
or structured output, an independent command check can complement the browser
evidence. Calibrate against a known-good target and a deliberate defect.

## Capabilities shared across evaluation types

- [Case matrices and splits](specs.md#case-matrices-strata-and-splits) vary
  scenarios across users, inputs, or states. [Text datasets](text-evaluation.md#datasets-grouped-cases-and-reusable-templates)
  provide grouped text cases and reusable templates.
- [Repeated judging](visual-evaluation.md#repeated-rubric-judging) samples model
  decisions over fixed evidence. [Campaigns](comparisons.md#repeated-run-campaigns)
  repeat whole evaluations to examine stability.
- [Separate collection and judging](evidence-workflows.md) lets you evaluate
  different judging methods against the same sealed observations.
- [Comparisons](comparisons.md#compare-runs), [promotion policies](evidence-workflows.md#baseline-promotion-policy),
  and [CI gates](runs.md#ci-thresholds) support regression and release decisions.

Score measures performance on judged evidence; coverage measures how much could
be judged. Missing evidence and valid abstentions do not become fabricated scores.
Execution errors remain failures of the evaluation process.

## Boundaries to plan for

- **Authoring is project-owned.** The [authoring skill](authoring.md) generates CLI/YAML setup through an interview. You supply
  requirements, expected values, fixtures, preparation/reset, and any custom
  checker or collector. Starters do not discover these automatically.
- **Source inspection cannot prove runtime behavior.** Workspace agents can
  list, read, and search. Runtime/API assertions need exercised browser evidence
  or an explicitly configured command checker.
- **Files and media may need extraction.** File helpers inspect JSON, CSV, ZIP,
  and binary metadata. PDF, spreadsheet, and calendar semantics need your parser.
  Exported documents and video can supply extracted images through your collector;
  sampled frames do not establish continuous playback quality.
- **Judgement needs calibration.** Image statistics do not establish aesthetics,
  a pairwise win does not establish absolute quality, and text quotations do not
  prove factual truth. Text judges can check supplied sources but do not independently
  research external facts. Repeated agreement measures consistency, not correctness.
- **Delivery and runtime have limits.** The offline first-run and most examples
  require this source checkout; the tarball includes text-datasets and authoring examples,
  the authoring skill, and generated starters. Linux is validated, native Windows evaluation is unsupported
  (use WSL), and macOS is not CI-certified. See [requirements](../README.md#requirements).
