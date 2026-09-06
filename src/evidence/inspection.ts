import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const imageViewSchema = z
  .object({
    at: z.iso.datetime(),
    tool: z.literal("view_screenshot"),
    reference: z.string(),
    result: z.string(),
    isError: z.boolean().optional(),
  })
  .strict();

/** Only successful, schema-valid MCP responses establish image access. */
export function inspectedScreenshots(directory: string): Set<string> {
  const transcript = path.join(directory, "evidence-transcript.ndjson");
  const viewed = new Set<string>();
  if (fs.existsSync(transcript)) {
    for (const [index, line] of fs.readFileSync(transcript, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid image-view transcript JSON: ${transcript}:${index + 1}`);
      }
      const parsed = imageViewSchema.safeParse(value);
      if (!parsed.success)
        throw new Error(
          `Invalid image-view transcript record: ${transcript}:${index + 1}: ${parsed.error.message}`,
        );
      if (!parsed.data.isError) viewed.add(parsed.data.reference);
    }
  }
  return viewed;
}

/** Attachments and MCP views establish access through different mechanisms.
 * Callers select required refs: cited images for rubric claims, both panels for pairwise decisions.
 */
export function assertScreenshotAccess(options: {
  directory: string;
  access: "attached" | "mcp";
  selectedRefs: string[];
  requiredRefs: string[];
  context: string;
}): void {
  const selected = new Set(options.selectedRefs);
  const viewed = options.access === "attached" ? selected : inspectedScreenshots(options.directory);
  const missing = [...new Set(options.requiredRefs)].filter(
    (ref) => !selected.has(ref) || !viewed.has(ref),
  );
  if (missing.length)
    throw new Error(
      `${options.context} contract violation: cited screenshots require successful image access; missing ${missing.join(", ")}. See ${options.directory} for retained judge diagnostics.`,
    );
}
