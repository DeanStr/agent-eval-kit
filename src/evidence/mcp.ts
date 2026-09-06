#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { EvidenceMcpContext } from "./context.js";

const contextFile = process.argv[2];
if (!contextFile) {
  console.error("Usage: aek-evidence-mcp <evidence-context.json>");
  process.exit(2);
}

const context = JSON.parse(
  fs.readFileSync(path.resolve(contextFile), "utf8"),
) as EvidenceMcpContext;
const root = fs.realpathSync(context.attachmentRoot);
let calls = 0;

function attachment(reference: string): string {
  const configured = context.screenshots[reference];
  if (!configured || path.basename(configured) !== configured) {
    throw new Error(`Unknown screenshot reference: ${reference}`);
  }
  const file = fs.realpathSync(path.join(root, configured));
  if (path.dirname(file) !== root || !fs.statSync(file).isFile()) {
    throw new Error(`Invalid screenshot attachment: ${reference}`);
  }
  return file;
}

function record(reference: string, result: string, isError = false): void {
  fs.appendFileSync(
    context.transcriptFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      tool: "view_screenshot",
      reference,
      result,
      ...(isError ? { isError: true } : {}),
    })}\n`,
  );
}

const server = new McpServer({ name: "agent-eval-evidence", version: "0.1.0" });
server.registerTool(
  "view_screenshot",
  {
    description:
      "View one screenshot selected for this judgement, using its exact canonical evidence ref.",
    inputSchema: { ref: z.string().min(1) },
  },
  ({ ref }) => {
    calls += 1;
    if (calls > context.maxToolCalls) {
      const result = `Screenshot tool-call budget (${context.maxToolCalls}) exhausted.`;
      record(ref, result, true);
      return { content: [{ type: "text" as const, text: result }], isError: true };
    }
    try {
      const file = attachment(ref);
      const data = fs.readFileSync(file).toString("base64");
      const mimeType = path.extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
      record(ref, "Screenshot returned.");
      return {
        content: [
          { type: "text" as const, text: `Screenshot evidence: ${ref}` },
          { type: "image" as const, data, mimeType },
        ],
      };
    } catch (error) {
      const result = error instanceof Error ? error.message : String(error);
      record(ref, result, true);
      return { content: [{ type: "text" as const, text: result }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
