#!/usr/bin/env node
import { registerOutputTool } from "../workflow.js";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TranscriptEntry } from "../types.js";
import type { WorkspaceMcpContext, WorkspaceResultState } from "./context.js";
import { prospectiveRealPath, writeJson } from "../io.js";

const contextFile = process.argv[2];
if (!contextFile) {
  console.error("Usage: aek-workspace-mcp <workspace-context.json>");
  process.exit(2);
}

const context = JSON.parse(
  fs.readFileSync(path.resolve(contextFile), "utf8"),
) as WorkspaceMcpContext;
const root = fs.realpathSync(context.projectRoot);
fs.mkdirSync(context.evidenceDir, { recursive: true });
const transcriptFile = path.join(context.evidenceDir, "workspace-transcript.ndjson");
const observationsFile = path.join(context.evidenceDir, "observations.json");
const resultFile = path.join(context.evidenceDir, "workspace-result.json");
const observations: string[] = [];
let step = 0;
const MAX_READ_OUTPUT_CHARACTERS = 32_000;

const excludedDirectories = new Set([
  ".agent-eval",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function record(entry: TranscriptEntry): void {
  fs.appendFileSync(transcriptFile, `${JSON.stringify(entry)}\n`);
}

function insideRoot(candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

const evaluatorOnlyRoots = (context.evaluatorOnlyPaths ?? [])
  // Some protected locations (notably .env, auth, and baselines) are optional
  // and may not exist when the MCP starts. Resolve the nearest existing
  // ancestor so the future path remains hidden without weakening checks for
  // existing symlinks or unreadable ancestors.
  .map((configured) => prospectiveRealPath(configured))
  .filter(insideRoot);

function evaluatorOnly(candidate: string): boolean {
  return evaluatorOnlyRoots.some(
    (hidden) => candidate === hidden || candidate.startsWith(`${hidden}${path.sep}`),
  );
}

function excludedProjectPath(candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".") return false;
  const parts = relative.split(path.sep);
  // The final component is itself a directory only when the requested path is
  // a directory; otherwise only its ancestors should be checked. This keeps a
  // regular file named `build` visible while still rejecting build/file.txt.
  const directories = fs.statSync(candidate).isDirectory() ? parts : parts.slice(0, -1);
  return directories.some((part) => excludedDirectories.has(part));
}

function projectPath(relative = "."): string {
  const lexical = path.resolve(root, relative);
  if (!insideRoot(lexical)) throw new Error(`Path escapes project root: ${relative}`);
  if (excludedProjectPath(lexical))
    throw new Error(`Excluded project path is not available to scenario agents: ${relative}`);
  const actual = fs.realpathSync(lexical);
  if (!insideRoot(actual)) throw new Error(`Symlink escapes project root: ${relative}`);
  if (excludedProjectPath(actual))
    throw new Error(`Excluded project path is not available to scenario agents: ${relative}`);
  if (evaluatorOnly(actual))
    throw new Error(`Evaluator-only path is not available to scenario agents: ${relative}`);
  return actual;
}

function relativePath(absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

function collectFiles(start = root, maximum = 2_000): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const pending = [start];
  let truncated = false;
  while (pending.length && files.length < maximum) {
    const directory = pending.pop()!;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maximum) {
        truncated = true;
        break;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (evaluatorOnly(absolute)) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relativePath(absolute));
      }
    }
  }
  if (pending.length) truncated = true;
  return { files: files.sort(), truncated };
}

function textFile(relative: string, maximumBytes = 1_000_000): string | undefined {
  const absolute = projectPath(relative);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`Not a file: ${relative}`);
  if (stat.size > maximumBytes) return undefined;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}

async function callTool(
  tool: string,
  input: Record<string, unknown>,
  action: () => string | Promise<string>,
) {
  step += 1;
  if (context.maxToolCalls !== undefined && step > context.maxToolCalls) {
    const result = `ERROR: workspace tool-call budget (${context.maxToolCalls}) exhausted. Record what remains unverified and finish.`;
    record({ step, at: new Date().toISOString(), tool, input, result, isError: true });
    return { content: [{ type: "text" as const, text: result }], isError: true };
  }
  try {
    const result = await action();
    record({ step, at: new Date().toISOString(), tool, input, result: result.slice(0, 8_000) });
    return { content: [{ type: "text" as const, text: `${result}\nEvidence step: ${step}` }] };
  } catch (error) {
    const result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    record({ step, at: new Date().toISOString(), tool, input, result, isError: true });
    return { content: [{ type: "text" as const, text: result }], isError: true };
  }
}

const server = new McpServer({ name: "agent-eval-workspace", version: "0.1.0" });

server.registerTool(
  "list_files",
  {
    description:
      "List project files without exposing dependency, build, VCS, or prior-evaluation directories.",
    inputSchema: {
      path: z.string().default("."),
      contains: z.string().optional().describe("Optional case-insensitive substring filter"),
      limit: z.number().int().positive().max(2_000).default(500),
    },
  },
  ({ path: requested, contains, limit }) =>
    callTool("list_files", { path: requested, contains, limit }, () => {
      const start = projectPath(requested);
      if (!fs.statSync(start).isDirectory()) throw new Error(`Not a directory: ${requested}`);
      const collected = collectFiles(start, 2_000);
      const match = contains?.toLowerCase();
      const matching = match
        ? collected.files.filter((file) => file.toLowerCase().includes(match))
        : collected.files;
      const files = matching.slice(0, limit);
      const truncated = collected.truncated || matching.length > limit;
      return `${files.join("\n") || "(no matching files)"}${truncated ? "\n… file list truncated" : ""}`;
    }),
);

server.registerTool(
  "read_file",
  {
    description:
      "Read a bounded line and character range from a text file inside the project root.",
    inputSchema: {
      path: z.string().min(1),
      startLine: z.number().int().positive().default(1),
      endLine: z.number().int().positive().optional(),
    },
  },
  ({ path: requested, startLine, endLine }) =>
    callTool("read_file", { path: requested, startLine, endLine }, () => {
      const text = textFile(requested, 2_000_000);
      if (text === undefined) throw new Error(`File is binary or larger than 2 MB: ${requested}`);
      const lines = text.split(/\r?\n/);
      const requestedFinalLine = endLine ?? startLine + 399;
      const finalLine = Math.min(requestedFinalLine, startLine + 999, lines.length);
      if (finalLine < startLine) throw new Error("endLine must not precede startLine");
      let result = "";
      let truncated = false;
      for (const [index, line] of lines.slice(startLine - 1, finalLine).entries()) {
        const rendered = `${startLine + index}: ${line}`;
        const addition = `${result ? "\n" : ""}${rendered}`;
        const remaining = MAX_READ_OUTPUT_CHARACTERS - result.length;
        if (addition.length > remaining) {
          result += addition.slice(0, Math.max(0, remaining));
          truncated = true;
          break;
        }
        result += addition;
      }
      if (truncated) {
        return `${result}\n… read output truncated at ${MAX_READ_OUTPUT_CHARACTERS} characters; request a narrower line range`;
      }
      if (finalLine < Math.min(requestedFinalLine, lines.length)) {
        return `${result}\n… read output truncated at 1000 lines; continue with startLine ${finalLine + 1}`;
      }
      return result;
    }),
);

server.registerTool(
  "search",
  {
    description: "Search project text files for a literal string and return file:line evidence.",
    inputSchema: {
      query: z.string().min(1),
      path: z.string().default("."),
      caseSensitive: z.boolean().default(false),
      maxMatches: z.number().int().positive().max(200).default(100),
    },
  },
  ({ query, path: requested, caseSensitive, maxMatches }) =>
    callTool("search", { query, path: requested, caseSensitive, maxMatches }, () => {
      const start = projectPath(requested);
      const collected = fs.statSync(start).isFile()
        ? { files: [relativePath(start)], truncated: false }
        : collectFiles(start, 4_000);
      const candidates = collected.files;
      const needle = caseSensitive ? query : query.toLowerCase();
      const matches: string[] = [];
      for (const file of candidates) {
        const text = textFile(file);
        if (text === undefined) continue;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (haystack.includes(needle))
            matches.push(`${file}:${index + 1}: ${line.slice(0, 500)}`);
          if (matches.length >= maxMatches) return `${matches.join("\n")}\n… matches truncated`;
        }
      }
      return `${matches.join("\n") || "(no matches)"}${collected.truncated ? "\n… search file set truncated after 4000 eligible files; additional files were not searched" : ""}`;
    }),
);

server.registerTool(
  "observe",
  {
    description:
      "Record a concise factual observation with file:line evidence for the independent judge.",
    inputSchema: { note: z.string().min(1) },
  },
  ({ note }) =>
    callTool("observe", { note }, () => {
      observations.push(note);
      writeJson(observationsFile, observations);
      return "Observation recorded.";
    }),
);

registerOutputTool(server, {
  ...(context.outputs === undefined ? {} : { outputs: context.outputs }),
  directory: context.evidenceDir,
  transcriptFile,
  call: (input, action) => callTool("publish_output", input, action),
});

server.registerTool(
  "done",
  {
    description:
      "Finish workspace evidence collection with an honest outcome and evidence-grounded summary.",
    inputSchema: {
      outcome: z.enum(["completed", "blocked", "feature_not_found"]),
      summary: z.string().min(1),
    },
  },
  ({ outcome, summary }) => {
    // Finalization remains available after the inspection budget is exhausted.
    step += 1;
    const state: WorkspaceResultState = {
      outcome,
      summary,
      observations,
      finishedAt: new Date().toISOString(),
    };
    writeJson(resultFile, state);
    const result = "Scenario evidence finalized. Return the required structured result now.";
    record({
      step,
      at: new Date().toISOString(),
      tool: "done",
      input: { outcome, summary },
      result,
    });
    return { content: [{ type: "text" as const, text: result }] };
  },
);

await server.connect(new StdioServerTransport());
