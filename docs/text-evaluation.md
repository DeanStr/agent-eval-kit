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
scenarios. Text comparisons produce rubric-level results, not scenario/case
results or strata. Use separate rubric items for separate passages, and area
selection to reserve evaluation passages.

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
and content hashes. Quotes must occur exactly in the indicated input; malformed
or missing required citations are execution errors, even at low confidence.

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
