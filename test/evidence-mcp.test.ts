import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { EvidenceMcpContext } from "../src/evidence/context.js";
import { writeJson } from "../src/io.js";
import { inspectedScreenshots } from "../src/evidence/inspection.js";
import { evidenceMcpLaunch } from "../src/mcp-config.js";

test("evidence MCP exposes only explicitly selected screenshots", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-evidence-mcp-"));
  const attachments = path.join(directory, "attachments");
  fs.mkdirSync(attachments);
  const image = Buffer.from("selected screenshot bytes");
  fs.writeFileSync(path.join(attachments, "selected.jpg"), image);
  fs.writeFileSync(path.join(directory, "not-selected.jpg"), "private");
  const contextFile = path.join(directory, "context.json");
  writeJson(contextFile, {
    attachmentRoot: attachments,
    screenshots: { "S1/screenshots/selected.jpg": "selected.jpg" },
    transcriptFile: path.join(directory, "evidence-transcript.ndjson"),
    maxToolCalls: 2,
  } satisfies EvidenceMcpContext);
  const launch = evidenceMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "aek-evidence-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["view_screenshot"],
    );
    const selected = await client.callTool({
      name: "view_screenshot",
      arguments: { ref: "S1/screenshots/selected.jpg" },
    });
    const content = selected.content as Array<{ type: string; data?: string }>;
    const imageContent = content.find((item) => item.type === "image");
    assert.equal(imageContent?.type, "image");
    if (imageContent?.type === "image" && imageContent.data) {
      assert.equal(Buffer.from(imageContent.data, "base64").toString(), image.toString());
    }
    const denied = await client.callTool({
      name: "view_screenshot",
      arguments: { ref: "../not-selected.jpg" },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Unknown screenshot reference/);
    assert.deepEqual([...inspectedScreenshots(directory)], ["S1/screenshots/selected.jpg"]);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
