import { z } from "zod";
import { votingSchema } from "../visual/contracts.js";

export const TEXT_METHOD_VERSION = 3;
export const MAX_TEXT_BYTES = 128 * 1024;
const filePath = z
  .string()
  .min(1)
  .refine(
    (value) => !/^[a-z][a-z0-9+.-]*:/i.test(value),
    "Use a pinned local UTF-8 text file, not a URL",
  );
export const textSourceSchema = z.union([
  filePath,
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      reference: z.string().min(1),
      key: z.string().min(1),
      snapshot: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
export type TextSource = z.infer<typeof textSourceSchema>;
const file = textSourceSchema;
export const defaultTextVoting = {
  minimumVotes: 5,
  maximumVotes: 9,
  agreement: 0.8,
  minimumConfidence: 0.55,
};
export const textRubricSchema = z
  .object({
    type: z.literal("text-rubric"),
    inputs: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
        z
          .object({
            file,
            role: z.enum(["candidate", "reference"]).default("candidate"),
          })
          .strict(),
      )
      .refine(
        (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 40,
        "Supply between 1 and 40 text inputs",
      ),
    voting: votingSchema.optional(),
  })
  .strict();
export type TextRubricGrader = z.infer<typeof textRubricSchema>;
// Only these formatting characters are interchangeable; other characters stay literal.
function matchCitation(quote: string, source: string | undefined, label: string) {
  if (source !== undefined && quote.trim()) {
    if (source.includes(quote)) return { sourceQuote: quote, whitespaceNormalized: false };
    const normalizedQuote = quote.replace(/[ \t\r\n]+/g, " ");
    const runs: Array<{ offset: number; removed: number }> = [];
    let removed = 0;
    const normalizedSource = source.replace(/[ \t\r\n]+/g, (run, offset: number) => {
      runs.push({ offset: offset - removed, removed: run.length - 1 });
      removed += run.length - 1;
      return " ";
    });
    const start = normalizedSource.indexOf(normalizedQuote);
    if (start !== -1) {
      const end = start + normalizedQuote.length;
      let sourceStart = start;
      let sourceEnd = end;
      // Restore characters removed before each boundary, including a trailing whitespace run.
      for (const run of runs) {
        if (run.offset < start) sourceStart += run.removed;
        if (run.offset < end) sourceEnd += run.removed;
      }
      return { sourceQuote: source.slice(sourceStart, sourceEnd), whitespaceNormalized: true };
    }
  }
  throw new Error(`Text judge citation does not quote supplied text ${label}`);
}

const citationMatchShape = {
  sourceQuote: z.string().min(1),
  whitespaceNormalized: z.boolean(),
};

export const textRubricResultSchema = z
  .object({
    verdict: z.enum(["pass", "partial", "fail", "cannot_judge"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().trim().min(1),
    citations: z
      .array(
        z
          .object({
            text: z.string().min(1),
            quote: z.string().min(1).max(2000),
            explanation: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export const validatedTextRubricResultSchema = textRubricResultSchema.extend({
  citations: textRubricResultSchema.shape.citations.element
    .extend(citationMatchShape)
    .array()
    .max(40),
});
export function validateTextRubricResult(value: unknown, texts: Record<string, string>) {
  const result = z.union([textRubricResultSchema, validatedTextRubricResultSchema]).parse(value);
  const citations = result.citations.map((citation) => ({
    ...citation,
    ...matchCitation(
      citation.quote,
      Object.hasOwn(texts, citation.text) ? texts[citation.text] : undefined,
      citation.text,
    ),
  }));
  if (result.verdict !== "cannot_judge") {
    for (const name of Object.keys(texts))
      if (!result.citations.some((citation) => citation.text === name))
        throw new Error(`Text judge must cite ${name} for a non-abstaining judgment`);
  }
  return { ...result, citations };
}
export const textPairwiseSchema = z
  .object({
    type: z.literal("text-pairwise"),
    candidate: file,
    references: z.array(z.object({ file }).strict()).min(1).max(20),
    styleTarget: z.object({ file }).strict().optional(),
    policy: z.enum(["preference", "non_regression"]),
    voting: votingSchema.optional(),
  })
  .strict();
export type TextPairwiseGrader = z.infer<typeof textPairwiseSchema>;

export const textPairResultSchema = z
  .object({
    preferred: z.enum(["A", "B", "equivalent", "abstain"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().trim().min(1),
    citations: z
      .array(
        z
          .object({
            text: z.enum(["A", "B", "R"]),
            quote: z.string().min(1).max(2000),
            explanation: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export const validatedTextPairResultSchema = textPairResultSchema.extend({
  citations: textPairResultSchema.shape.citations.element
    .extend(citationMatchShape)
    .array()
    .max(12),
});
export type TextPairResult = z.infer<typeof validatedTextPairResultSchema>;

/** Validate fresh and resumed votes against exactly the texts the judge saw. */
export function validateTextPairResult(
  value: unknown,
  texts: { A: string; B: string; R?: string },
): TextPairResult {
  const result = z.union([textPairResultSchema, validatedTextPairResultSchema]).parse(value);
  const citations = result.citations.map((citation) => ({
    ...citation,
    ...matchCitation(
      citation.quote,
      Object.hasOwn(texts, citation.text) ? texts[citation.text] : undefined,
      citation.text,
    ),
  }));
  if (result.preferred !== "abstain") {
    for (const label of texts.R === undefined ? ["A", "B"] : ["A", "B", "R"]) {
      if (!result.citations.some((citation) => citation.text === label))
        throw new Error(`Text judge must cite ${label} for a non-abstaining comparison`);
    }
  }
  return { ...result, citations };
}
