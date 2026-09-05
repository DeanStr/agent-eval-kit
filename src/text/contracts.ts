import { z } from "zod";
import { votingSchema } from "../visual/contracts.js";

export const TEXT_METHOD_VERSION = 1;
export const MAX_TEXT_BYTES = 128 * 1024;
const file = z.string().min(1).refine(value => !/^[a-z][a-z0-9+.-]*:/i.test(value), "Use a pinned local UTF-8 text file, not a URL");
export const textPairwiseSchema = z.object({
  type: z.literal("text-pairwise"),
  candidate: file,
  references: z.array(z.object({ file }).strict()).min(1).max(20),
  styleTarget: z.object({ file }).strict().optional(),
  policy: z.enum(["preference", "non_regression"]),
  voting: votingSchema.default({ minimumVotes: 5, maximumVotes: 9, agreement: 0.8, minimumConfidence: 0.55 }),
}).strict();
export type TextPairwiseGrader = z.infer<typeof textPairwiseSchema>;

export const textPairResultSchema = z.object({
  preferred: z.enum(["A", "B", "equivalent", "abstain"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1),
  citations: z.array(z.object({
    text: z.enum(["A", "B", "R"]),
    quote: z.string().min(1).max(2000),
    explanation: z.string().trim().min(1),
  }).strict()).max(12),
}).strict();
export type TextPairResult = z.infer<typeof textPairResultSchema>;

/** Validate fresh and resumed votes against exactly the texts the judge saw. */
export function validateTextPairResult(value: unknown, texts: { A: string; B: string; R?: string }): TextPairResult {
  const result = textPairResultSchema.parse(value);
  for (const citation of result.citations) {
    const source = texts[citation.text];
    if (!citation.quote.trim() || source === undefined || !source.includes(citation.quote))
      throw new Error(`Text judge citation does not quote supplied text ${citation.text}`);
  }
  if (result.preferred !== "abstain") {
    for (const label of texts.R === undefined ? ["A", "B"] : ["A", "B", "R"]) {
      if (!result.citations.some(citation => citation.text === label))
        throw new Error(`Text judge must cite ${label} for a non-abstaining comparison`);
    }
  }
  return result;
}
