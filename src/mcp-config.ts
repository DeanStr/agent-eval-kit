import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeJson } from "./io.js";

export const BROWSER_TOOL_NAMES = [
  "navigate",
  "snapshot",
  "click",
  "fill",
  "select",
  "drag",
  "upload",
  "press",
  "scroll",
  "wait",
  "screenshot",
  "observe",
  "publish_output",
  "switch_persona",
  "done",
];

export const WORKSPACE_TOOL_NAMES = ["list_files", "read_file", "search", "observe", "publish_output", "done"];
export const EVIDENCE_TOOL_NAMES = ["view_screenshot"];

function mcpLaunch(entry: string, contextFile: string): { command: string; args: string[] } {
  const javascript = fileURLToPath(new URL(`./${entry}/mcp.js`, import.meta.url));
  if (fs.existsSync(javascript)) return { command: process.execPath, args: [javascript, contextFile] };

  const typescript = fileURLToPath(new URL(`./${entry}/mcp.ts`, import.meta.url));
  if (!fs.existsSync(typescript)) {
    throw new Error(`${entry} MCP entry point is missing (${javascript} / ${typescript})`);
  }
  const tsx = fileURLToPath(import.meta.resolve("tsx"));
  return { command: process.execPath, args: ["--import", pathToFileURL(tsx).href, typescript, contextFile] };
}

export function browserMcpLaunch(contextFile: string): { command: string; args: string[] } {
  return mcpLaunch("browser", contextFile);
}

export function workspaceMcpLaunch(contextFile: string): { command: string; args: string[] } {
  return mcpLaunch("workspace", contextFile);
}

export function evidenceMcpLaunch(contextFile: string): { command: string; args: string[] } {
  return mcpLaunch("evidence", contextFile);
}

export function writeMcpConfig(
  directory: string,
  name: string,
  command: string,
  args: string[],
): string {
  const file = path.join(directory, ".mcp.json");
  writeJson(file, { mcpServers: { [name]: { type: "stdio", command, args } } });
  return file;
}
