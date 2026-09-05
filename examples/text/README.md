# Compare writing by example

This example uses three short, synthetic passages written for the example. They are fictional, not human-authored reference articles or measured experiment results:

- `candidate.md`: the proposed revision.
- `original.md`: the previous version of the same text.
- `reference.md`: an example of the desired engineering-blog voice on another subject.

## Voice and revision

From the repository root:

```sh
pnpm aek run --config examples/text/evalkit.yaml --judge codex
```

The two rubric items demonstrate different input arrangements:

| Comparison | Anonymous A and B | Separate R | Decision |
| --- | --- | --- | --- |
| Reference comparison | Candidate and reference | None | Is the candidate voice at least as natural and convincing as the reference voice? |
| Style-guided revision | Candidate and original | Reference | Does the revision sound more like the kind of author represented by R? |

The full input texts are supplied on every vote. Voice is the deciding criterion: better organization or copyediting cannot compensate for weaker voice. The judge compares how the author sounds; it does not identify whether a human or AI wrote the text. R supplies an example of taste, not facts or wording to copy.

## Overall editorial quality

Run this separately:

```sh
pnpm aek run --config examples/text/quality.yaml --judge codex
```

This compares the candidate with the original for overall editorial quality. It has its own report so quality and voice do not compensate for each other in a combined score. A version can improve voice while losing on quality; inspect both results rather than treating either as a universal writing score.

## Voting and reports

The examples use adaptive voting: at least three votes, at most five, and 80% agreement. Three unanimous votes can decide immediately. A 2–1 split continues; 4–1 can decide, while 3–2 is inconclusive. Low-confidence votes and abstentions also affect the decision. Inconclusive results reduce coverage; they do not become fabricated scores. `non_regression` accepts observed equivalence, while `preference` requires an improvement.

Fresh votes randomize A/B order and require exact quotations as evidence. Reports and snapshots are written under ignored `.agent-eval/runs/` inside this example. Exit 2 means a threshold was not satisfied, including insufficient coverage; exit 1 indicates an execution error. Repeated judgments are not independent human votes or calibrated probabilities of reader preference.

Both configurations default to a mock judge for a local wiring check:

```sh
pnpm aek run --config examples/text/evalkit.yaml
pnpm aek run --config examples/text/quality.yaml
```

Mock text judgments abstain, so these commands should produce unavailable results and exit 2. Use `--judge codex` with an authenticated Codex CLI for actual judgments; the mock agent remains unused because there are no collection scenarios.

## Use your own articles

Replace the sample files or change the paths in the specs. Files must be nonempty UTF-8 text, at most 128 KiB each, and resolve inside the configured project root. Whole articles, including appendices, can be used. Web URLs are not accepted as text inputs; save the relevant article body locally first. Layout and image pixels are not evaluated.

Choose references whose voice you actually want. Keep the reference files and comparison brief fixed while revising the candidate, and keep candidate files unchanged until a run finishes. A changed brief starts a different comparison: its score should not be presented as improvement under the old criterion.

A broad “better written” question may reward polish while overlooking voice. Separate criteria make that tradeoff visible, but do not establish that the judge agrees with your taste. Factual fidelity needs its own check against the source record; a style win does not establish factual correctness. Don't remove necessary qualifications or invent personal experience to mimic a reference.
