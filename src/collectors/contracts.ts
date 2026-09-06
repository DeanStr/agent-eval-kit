import { outputSchema } from "../workflow.js";
import { z } from "zod";
import { isPortablePathComponent } from "../io.js";

const label = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .refine(isPortablePathComponent, "must be a portable file name");
export const collectorSchema = z
  .object({
    command: z.string().min(1),
    methodFiles: z
      .array(z.string().min(1))
      .max(50)
      .refine((v) => new Set(v).size === v.length, "methodFiles must be unique"),
    timeoutSeconds: z.number().positive().max(3600).default(300),
    sources: z
      .record(label, z.string().min(1))
      .refine((v) => Object.keys(v).length <= 20, "declare at most 20 source artifacts")
      .default({}),
    files: z
      .array(label)
      .max(30)
      .refine((v) => new Set(v).size === v.length, "file labels must be unique")
      .optional(),
    images: z
      .array(label)
      .max(30)
      .refine(
        (v) => new Set(v.map((s) => s.toLowerCase())).size === v.length,
        "image labels must be unique ignoring case",
      )
      .default([]),
  })
  .strict();

export const collectionManifestSchema = z
  .object({
    version: z.literal(1),
    outcome: z.enum(["completed", "blocked"]),
    summary: z.string().min(1),
    outputs: z.record(label, outputSchema).default({}),
    checkpoints: z
      .record(label, z.object({ evidenceRefs: z.array(z.literal("step:1")).length(1) }).strict())
      .default({}),
    files: z
      .array(
        z
          .object({
            label,
            path: z.string().min(1),
            mediaType: z.string().min(1),
            filename: z.string().min(1),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    observations: z.array(z.string().min(1)).max(100),
    images: z
      .array(
        z
          .object({
            label,
            path: z.string().min(1),
            source: label,
            extraction: z.string().min(1),
            timeSeconds: z.number().nonnegative().optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict();
