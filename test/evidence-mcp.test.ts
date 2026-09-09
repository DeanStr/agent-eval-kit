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
    screenshots: Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [
        index === 0 ? "S1/screenshots/selected.jpg" : `S1/screenshots/selected-${index}.jpg`,
        "selected.jpg",
      ]),
    ),
    transcriptFile: path.join(directory, "evidence-transcript.ndjson"),
    maxToolCalls: 32,
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
    for (let index = 1; index < 31; index++) {
      const retrieved = await client.callTool({
        name: "view_screenshot",
        arguments: { ref: `S1/screenshots/selected-${index}.jpg` },
      });
      assert.notEqual(retrieved.isError, true);
      assert.ok(
        (retrieved.content as Array<{ type: string }>).some((item) => item.type === "image"),
      );
    }
    const denied = await client.callTool({
      name: "view_screenshot",
      arguments: { ref: "../not-selected.jpg" },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Unknown screenshot reference/);
    assert.equal(inspectedScreenshots(directory).size, 31);
    const exhausted = await client.callTool({
      name: "view_screenshot",
      arguments: { ref: "S1/screenshots/selected.jpg" },
    });
    assert.equal(exhausted.isError, true);
    assert.match(JSON.stringify(exhausted.content), /budget \(32\) exhausted/);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
