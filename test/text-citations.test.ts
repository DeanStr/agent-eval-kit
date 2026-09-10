import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { validateTextPairResult, validateTextRubricResult } from "../src/text/contracts.js";

for (const kind of ["pairwise", "rubric"] as const) {
  const validate = (quote: string, source: string) => {
    const result = {
      confidence: 0.9,
      reasoning: "Evidence.",
      citations: [{ text: "A", quote, explanation: "Evidence." }],
    };
    // Abstentions still validate supplied citations, without requiring additional ones.
    return kind === "pairwise"
      ? validateTextPairResult({ ...result, preferred: "abstain" }, { A: source, B: quote })
      : validateTextRubricResult({ ...result, verdict: "cannot_judge" }, { A: source, B: quote });
  };

  test(`${kind}: exact matches take priority and formatting differences recover source text`, () => {
    const exact = validate("One two", "One\ntwo. One two.").citations[0]!;
    assert.equal(exact.sourceQuote, "One two");
    assert.equal(exact.whitespaceNormalized, false);
    for (const whitespace of [" ", "  ", "\t", "\n", "\r\n", " \t\r\n "]) {
      const source = `Before: One${whitespace}two [3]. After.`;
      const result = validate("One two [3].", source);
      assert.equal(result.citations[0]!.sourceQuote, `One${whitespace}two [3].`);
      assert.equal(result.citations[0]!.quote, "One two [3].");
      assert.equal(result.citations[0]!.whitespaceNormalized, whitespace !== " ");
      const resumed =
        kind === "pairwise"
          ? validateTextPairResult(result, { A: source, B: "unused" })
          : validateTextRubricResult(result, { A: source, B: "unused" });
      assert.deepEqual(resumed, result);
    }
    assert.equal(validate("One\n\ttwo", "One two").citations[0]!.sourceQuote, "One two");
  });

  test(`${kind}: source offsets survive earlier whitespace, Unicode, and boundary runs`, () => {
    const source = "😀\t\tBefore.\r\n  One\t two!\n\nAfter.";
    const citation = validate(" One two! ", source).citations[0]!;
    assert.equal(citation.sourceQuote, "\r\n  One\t two!\n\n");
    assert.equal(citation.whitespaceNormalized, true);
    assert.equal(validate("One two!", source).citations[0]!.sourceQuote, "One\t two!");
    assert.equal(
      validate("One\ttwo", "One\n two; One  two").citations[0]!.sourceQuote,
      "One\n two",
    );
  });

  test(`${kind}: altered evidence and wrong-input attribution still fail`, () => {
    for (const quote of [
      "one two [3].",
      "One three [3].",
      "One two [4].",
      "One two [3]!",
      "Onetwo [3].",
      "One two ... [3].",
      "One two [3]. invented",
      "One\u00a0two [3].",
      "One\ftwo [3].",
      "",
      " \t\r\n",
    ]) {
      // B contains the submitted quote; it cannot rescue a citation attributed to A.
      assert.throws(() => validate(quote, "One\ntwo [3]."));
    }
    assert.throws(() => validate("some thing", "something"));
    assert.throws(() => validate("One two [3].", "One\ntwo X3Y!"));
    assert.throws(() => validate("One two", "One\u00a0two"));
  });

  test(`${kind}: source recovery is not limited by the submitted quote length`, () => {
    const source = `One${" ".repeat(2100)}two`;
    const result = validate("One two", source);
    assert.equal(result.citations[0]!.sourceQuote, source);
    assert.deepEqual(
      kind === "pairwise"
        ? validateTextPairResult(result, { A: source, B: "unused" })
        : validateTextRubricResult(result, { A: source }),
      result,
    );
  });
}

// A child-process deadline also catches synchronous matching that blocks the event loop.
test("failed citations on long whitespace runs finish promptly", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { validateTextRubricResult } from ${JSON.stringify(new URL("../src/text/contracts.ts", import.meta.url).href)};
    assert.throws(() => validateTextRubricResult({
      verdict: "cannot_judge", confidence: 0.9, reasoning: "Evidence.",
      citations: [{text: "A", quote: " missing", explanation: "Evidence."}],
    }, {A: " ".repeat(128 * 1024 - 7) + "present"}), /does not quote supplied text/);
  `,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
