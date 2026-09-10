# Direct text comparison

`text-pairwise` compares writing directly. A reference passage can express the
desired style and taste without turning that preference into a detailed rubric.
The judge chooses between anonymous texts, explains its editorial preference,
and quotes evidence from both passages.

The [runnable example](../examples/text/evalkit.yaml) includes two comparisons:
candidate versus target writing, and candidate versus original with a fixed
style target. Its short passages are synthetic fixtures created for the example,
not published human reference articles or real experimental results. Replace
them with your own candidate and selected reference passages.

```sh
pnpm aek run --config examples/text/evalkit.yaml --judge codex
```

Without `--judge codex` (or another supported real judge), the example uses the
offline mock, which abstains. Its unavailable critical gate exits with status 2;
this verifies the workflow without claiming that the writing is good.

## Configuration

```yaml
id: writing
title: Writing
weight: 100
description: An editorial comparison of technical prose.
scenarios: []
rubric:
  - id: STYLE
    criterion: Which passage would you prefer to read in a technical experiment report?
    passCriteria: The candidate is at least as well written as the reference.
    weight: 1
    gate: true
    grader:
      type: text-pairwise
      candidate: article/intro.md
      references:
        - file: evals/references/intro.md
      policy: non_regression
      voting:
        minimumVotes: 5
        maximumVotes: 9
        agreement: 0.8
        minimumConfidence: 0.55
```

The criterion and pass criteria are a short comparison brief. They need not
enumerate style rules. The default judge prompt asks for a holistic assessment
of style, voice, rhythm, and editorial taste, with no numeric style score.

This grader reads the declared files directly; its rubric `scenarios` must be
empty. An area using only direct text, command, or manual graders can omit
scenarios. Without a dataset, text comparisons produce rubric-level results. Bind a rubric
to a dataset for case results, grouped inputs, strata, and development/evaluation
splits. Separate rubric items express separate criteria.

Paths resolve from `project.root` and must stay within it, including symlinks.
Inputs must be nonempty UTF-8 text files of at most 128 KiB each. URLs, malformed
UTF-8, binary control characters, missing files, and invalid contracts fail
before a run directory is created. Prepare generated text before running AEK;
target setup or command graders that change snapshotted candidates fail the run.

Text bytes and paragraph structure are preserved. There is no automatic fetching,
HTML extraction, truncation, author removal, or phrase-overlap scoring. Select
comparable passages yourself, such as introductions of similar scope, and remove
bylines and publication branding if they would bias the comparison. File paths
and candidate/reference labels are not sent to the judge. Names present in the
text itself remain visible.

## A fixed target voice

To compare two versions against a particular reference voice, add `styleTarget`:

```yaml
grader:
  type: text-pairwise
  candidate: article/revision.md
  references: [{ file: article/original.md }]
  styleTarget: { file: evals/references/desired-voice.md }
  policy: preference
```

The judge sees anonymous alternatives A/B plus R, the fixed style target, and
chooses which alternative better achieves R's style and editorial quality.
It must cite A, B, and R. R supplies taste, not facts to import or wording to copy.

## Decisions and retained evidence

Each vote uses a fresh provider context with independently randomized A/B order.
All text is supplied in the prompt; judges may not use tools. Completed votes
retain the prompt, provider response, raw decision, ordering, literal quotations,
and content hashes. Quotes are checked against the indicated input, trying an
exact match first. If that fails, runs of spaces, tabs, and CR/LF line breaks
may differ; all other characters must remain unchanged. Whitespace cannot be
removed to join words. Each validated citation retains the submitted `quote`,
the original passage as `sourceQuote`, and a `whitespaceNormalized` flag. Reports
show the source formatting and label normalized matches; raw provider artifacts
remain unchanged. A normalized match establishes textual provenance, not fidelity
to formatting. Malformed or missing required citations are execution errors,
even at low confidence.

The judge returns A, B, `equivalent`, or `abstain`. `preference` requires candidate
wins; `non_regression` also accepts observed equivalence. Low-confidence votes
become abstentions. The existing adaptive voting policy needs the configured
agreement fraction of all attempted votes, including abstentions. An unresolved
decision at the vote limit becomes `cannot_judge` and reduces coverage. Provider,
tool-policy, schema, and citation failures abort instead of becoming votes.

Every declared reference is compared separately and must pass for a full rubric
pass. Mixed fully observed results yield partial credit; any inconclusive
comparison makes the rubric unavailable. Gate and score/coverage semantics are
the same as other graders. Vote agreement describes consistency among judges;
use your own preferences on a few sample pairs to check whether they share your
taste.

The normal report links to a standalone text comparison page showing candidate,
reference, optional style target, and each vote's rationale and passage citations.
Quoted text is escaped rather than rendered as HTML. Machine-readable results
retain both anonymous and candidate/reference mappings. No automatic quality
claim follows from a mock run or a fabricated provider test.

Candidate and reference files are snapshotted and hashed. Candidate edits change
run input identity while keeping the evaluator comparable across new runs.
Reference/style-target edits change evaluator identity. Changes to either prevent
resuming an old run. Inputs and completed setup are sealed before the first judge
call, so even a failure on that call can resume without repeating setup.
Interrupted runs reuse intact completed votes; changed input or vote artifacts
are rejected. Comparison reports identify changed text references or style targets.
Offline rescore preserves the original text receipts and
judgments without requiring the original files; it does not invoke a new judge.

Style preference does not verify factual accuracy. For revisions of research
reports, assess preservation of claims and uncertainty separately using an
explicitly configured factual check or human review.

## Datasets, grouped cases, and reusable templates

A direct text rubric can bind to a dataset independently of collection scenarios.
Each case has a stable ID, named inputs, optional `strata`, and an optional
`development` or `evaluation` split. Multiple related texts in one case can be
judged together. See the [dataset example](../examples/text-datasets/README.md).

```yaml
id: policy
title: Coherence and policy
weight: 100
description: Check related copy against a supplied source record.
datasets:
  posts:
    - id: launch
      split: development
      strata: {topic: launch}
      inputs:
        post: {text: "The pilot succeeded on 38 of 40 projects."}
        social: {text: "Our pilot completed 38 of 40 projects."}
        source: source-record.md
templates:
  coherence:
    dataset: posts
    criterion: Do both texts preserve the source's claims and uncertainty?
    passCriteria: No contradictions, unsupported claims, or lost qualifications.
    weight: 1
    gate: true
    grader:
      type: text-rubric
      inputs:
        post: {file: '{{inputs.post}}'}
        social: {file: '{{inputs.social}}'}
        source: {file: '{{inputs.source}}', role: reference}
rubric:
  - {id: COHERENCE, template: coherence}
```

`datasets.posts` can instead be `{file: ../datasets/posts.json}`. The JSON or YAML
manifest contains an array of cases, at most 16 MiB. Manifest paths resolve from
the spec file; text file paths resolve from `project.root`. External datasets are
embedded in sealed spec snapshots and their source manifests are hidden from
collection agents. Several specs can share one dataset manifest.

Input values accept a local path, an inline `{text: ...}` object, or a promoted
reference object described below. The same 128 KiB, nonempty UTF-8 restrictions
apply to inline text. A binding must occupy the entire source value, such as
`'{{inputs.post}}'`; there is no arbitrary interpolation, executable templating,
or automatic file generation. Unknown inputs, templates, duplicate/case-colliding
IDs, malformed manifests, and invalid text fail before execution.

Templates are local to a spec. Each rubric entry shallowly overrides its named
template; replacing `grader` replaces the entire grader object. Nested templates
are rejected. Dataset binding also works directly on a rubric without a template,
including `text-pairwise` candidate, references, and style target.

Each criterion retains its case results, split, strata, and evidence links.
Within a dataset criterion, each selected-split case receives an equal share of
its weight in both headline and strata scores. Unavailable cases reduce coverage; observed cases contribute their
configured verdict points. An aggregate full pass requires every case to pass;
any unavailable case makes the aggregate verdict and critical gate unavailable.
This differs from a single pairwise comparison with multiple references, which
remains unavailable when any required reference comparison is inconclusive.

Candidate content changes, including inline candidates, change run input identity.
Reference content and effective evaluator changes change evaluator identity.
Dataset membership, case metadata, and effective criteria or template changes
are evaluator changes. The hash retains each case's parent rubric and dataset,
including the grouping that determines scoring weights. Every spec uses a
normalized evaluator hash, so YAML
formatting, comments, and explicitly spelling out existing defaults do not change
evaluator identity. Exact source hashes remain in run provenance. All source
definitions are sealed for replay. Detached-run rescore can use those
sealed definitions without the original manifest; ordinary rescore against current
project definitions still reads the current manifest. Rescore allows scoring weight
changes, but rejects changed dataset inputs, membership, or metadata; evaluate
those changes in a new run. Comparison requires explicit spec method hashes for
every receipted spec; `--allow-incompatible` does not waive missing provenance.

## Direct rubric grading

`text-rubric` accepts 1–40 named `inputs` and uses the rubric's `criterion` and
`passCriteria`. It supports pass, partial, fail, and cannot_judge decisions with
adaptive voting. Set `role: reference` on source records or fixed policy text;
the default role is candidate. Roles determine input identity, not factual truth.

No collection scenario is needed. Each observed judgment must quote every
supplied input under the quotation-matching rules above and explain its relevance.
Missing or fabricated quotations, schema failures, forbidden tools, and provider errors abort the run,
even at low confidence. Valid low-confidence judgments and abstentions reduce
coverage. A checked quotation establishes where the evidence came from, not
whether the interpretation is correct. Claims can be checked against supplied
source records; outside facts are not independently verified.

Reports link to a standalone page containing each input, vote, rationale, and
quotation. The page escapes input text. The prompt and raw provider artifacts
are retained alongside the structured judgment. Mock judgments abstain.

## Shared defaults and named suites

A single config can declare separately runnable suites:

```yaml
version: 1
project: {name: Writing, root: .}
target: {kind: repository}
agent: {provider: mock}
judge:
  provider: mock
  voting: {minimumVotes: 3, maximumVotes: 5, agreement: 0.8}
scoring: {minimumCoverage: 100}
suites:
  voice:
    paths: {specs: specs/voice.yaml}
    instructions: Assess voice against the selected target voice.
  quality:
    paths: {specs: specs/quality.yaml}
    instructions: Assess overall editorial quality independently of voice.
```

Use `aek run --suite voice` and `aek run --suite quality`. Suites share the root
config and may override `agent`, `judge`, `paths`, `scoring`, and `instructions`.
Sections merge one level deep; nested values such as `judge.voting` replace the
whole value. CLI provider/model overrides take precedence. Unknown suite names
or override fields fail. Select a suite explicitly, or declare `suite: voice`
as the config's default. There is no implicit first suite.

For both direct text graders, explicit grader voting overrides `judge.voting`;
otherwise the built-in text voting policy applies (5–9 votes, 0.8 agreement,
0.55 minimum confidence). Each suite produces its own report, score, coverage,
and gates. The resolved config and selected suite are retained, including when
resuming without repeating flags. Commands that accept `--config` also accept
`--suite`, including detached judging, baseline management, and named-baseline
comparison. Commands that reload a retained run config inherit its suite override.
For detached rescore, finalize, or adjudicate, selecting a different suite also
requires `--config` to load current project definitions.

## Promoted text references

Promote the sealed candidate texts of a complete run:

```sh
aek reference promote --run "$RUN" --name editorial --reviewer dean
aek reference list
```

For a suite config, include `--suite <name>`. Promotion prints the available
input keys and immutable snapshot ID. Storage defaults to `evals/text-references`
and can be configured with `paths.references`; it must remain within
`project.root`, including symlinks. Names use lowercase portable identifiers.

A dataset input or grader source can refer to a promoted input:

```yaml
original:
  reference: editorial
  key: VOICE--launch
  # snapshot: <64-character SHA-256 printed by promotion>
```

For `text-rubric`, keys include the input name, such as `COHERENCE--launch/post`.
Omitting `snapshot` selects the name's current pointer; a new promotion changes
that pointer atomically and retains previous snapshots. Pin `snapshot` to retain
a specific reference. Manifests record reviewer, timestamp, source-run identity,
artifact-root hash, input keys, and content hashes. Both manifest and content
checksums are verified on use. Missing keys or damaged snapshots fail; there is
no substitute reference. Promotion copies sealed bytes, not edited working files.

Reference promotion selects comparison material; it is distinct from score
baseline promotion and does not certify the material's quality. Existing
`aek baseline` score snapshots and their release policies remain available.

## Changed-case selection

```sh
aek run --suite policy --changed-since "$PRIOR_RUN"
aek run --suite policy --text-cases policy/posts/launch
```

Selectors have the form `area/dataset/case` and are recorded as a sorted set;
reordering or repeating a selector does not change evaluator identity or prevent
resume. `--changed-since` requires a complete,
integrity-checked prior run with case fingerprints and the same areas and split.
It considers bound candidate and reference contents, shared inputs, case
metadata, criteria, grader settings, global instructions, scoring, judge settings,
and recorded method/runtime identity. A shared reference or judge change selects
all affected cases. New cases are selected; deleted cases disappear from the
current dataset and change evaluator identity. A prior subset does not establish
measurements for its skipped cases, so those cases are selected on the next run.

All selected-split inputs are still validated and snapshotted. Selection saves
judge calls; it does not bypass input validation. Other graders and scenarios
continue to run normally. If no cases changed, no dataset judge calls are made.

Unselected cases appear as `cannot_judge` with a selection explanation and reduce
coverage. Previous judgments are never copied into a new run. The exact selection
is recorded in the receipt and run state and restored by `--resume`. A subset is
not comparable to a full run under identical selection, and cannot be promoted
as a release baseline. Release promotion rejects missing or incomplete case
fingerprints when a text-case selection is recorded. Use a full run for release decisions. Changed selection
is available on `run`, not `collect` or campaigns.
