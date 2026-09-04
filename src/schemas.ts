import { z } from "zod";

export const scenarioOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { enum: ["completed", "blocked", "feature_not_found"] },
    summary: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    evidenceRefs: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "summary", "observations", "evidenceRefs"],
} as const;

export const scenarioOutputValidator = z.object({
  outcome: z.enum(["completed", "blocked", "feature_not_found"]),
  summary: z.string(),
  observations: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
}).strict();

export const judgementOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          verdict: { enum: ["pass", "partial", "fail", "not_found", "cannot_judge"] },
          confidence: { enum: ["high", "medium", "low"] },
          reasoning: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
        required: ["id", "verdict", "confidence", "reasoning", "evidenceRefs"],
      },
    },
    cases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          rubricId: { type: "string" },
          caseId: { type: "string" },
          verdict: { enum: ["pass", "partial", "fail", "not_found", "cannot_judge"] },
          confidence: { enum: ["high", "medium", "low"] },
          reasoning: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
        required: ["rubricId", "caseId", "verdict", "confidence", "reasoning", "evidenceRefs"],
      },
    },
    defects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { enum: ["critical", "major", "minor"] },
          description: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
        required: ["severity", "description", "evidenceRefs"],
      },
    },
    notes: { type: "string" },
  },
  required: ["items", "cases", "defects", "notes"],
} as const;

export const judgementOutputValidator = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
      confidence: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
      evidenceRefs: z.array(z.string()),
    }).strict(),
  ),
  cases: z.array(
    z.object({
      rubricId: z.string(),
      caseId: z.string(),
      verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
      confidence: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
      evidenceRefs: z.array(z.string()),
    }).strict(),
  ),
  defects: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      description: z.string(),
      evidenceRefs: z.array(z.string()),
    }).strict(),
  ),
  notes: z.string(),
}).strict();
