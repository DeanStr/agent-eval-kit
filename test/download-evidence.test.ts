import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserMcpLaunch } from "../src/mcp-config.js";
import { writeJson, readNdjson } from "../src/io.js";
import { inspectEvidenceFile } from "../src/evidence/files.js";
import { validateCheckpoints } from "../src/checkpoints.js";
import { validateOutputs } from "../src/workflow.js";
import type { BrowserMcpContext } from "../src/browser/context.js";
import type { EvidenceFile, TranscriptEntry } from "../src/types.js";
import { clickDownload } from "../src/browser/download.js";
import { chromium } from "playwright";

test("failed download waits finish their clicks and remove downloads observed during failure", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.setContent('<a download="test.txt" href="data:text/plain,hello">Download</a>');
    let downloadedPath: string | null = null;
    await assert.rejects(
      clickDownload(
        page,
        async () => {
          const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("a").click(),
          ]);
          downloadedPath = await download.path();
          throw new Error("Click inspection failed");
        },
        5000,
      ),
      /Click inspection failed/,
    );
    assert.ok(downloadedPath);
    assert.equal(fs.existsSync(downloadedPath), false);

    let clicked = false;
    await assert.rejects(
      clickDownload(
        page,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("a").click(),
          ]);
          downloadedPath = await download.path();
          clicked = true;
        },
        20,
      ),
      /timed out/,
    );
    assert.equal(clicked, true, "the next tool must not overlap an unfinished click");
    assert.equal(fs.existsSync(downloadedPath), false);
  } finally {
    await browser.close();
  }
});

test("browser download captures real bytes and persona, publishes file output, and seals a checkpoint before blockage", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/export") {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="results.csv"',
      });
      response.end("name,score\nAlice,4\n");
    } else {
      response.setHeader("content-type", "text/html");
      response.end('<h1>Results</h1><a href="/export">Download results</a>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-download-"));
  const context: BrowserMcpContext = {
    targetUrl: url,
    allowedOrigins: [url],
    evidenceDir: directory,
    persona: "reviewer",
    fixtureFiles: {},
    expectAuthenticated: false,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 5000,
    outputs: { export: { type: "file" } },
    checkpoints: { downloaded: "Results exported" },
  };
  const file = path.join(directory, "context.json");
  writeJson(file, context);
  const launch = browserMcpLaunch(file),
    transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
  const client = new Client({ name: "download-test", version: "1" });
  try {
    await client.connect(transport);
    const page = await client.callTool({ name: "navigate", arguments: { url } });
    const ref = /\[(e\d+)\].*?Download results/.exec(JSON.stringify(page.content))?.[1];
    assert.ok(ref, JSON.stringify(page));
    const download = await client.callTool({
      name: "download",
      arguments: { ref, label: "results" },
    });
    assert.notEqual(download.isError, true, JSON.stringify(download));
    const files = JSON.parse(
      fs.readFileSync(path.join(directory, "files.json"), "utf8"),
    ) as EvidenceFile[];
    assert.equal(files.length, 1);
    const evidence = files[0]!;
    assert.equal(evidence.filename, "results.csv");
    assert.equal(evidence.persona, "reviewer");
    assert.deepEqual(inspectEvidenceFile(directory, evidence, "csv"), [
      ["name", "score"],
      ["Alice", "4"],
    ]);
    const published = await client.callTool({
      name: "publish_output",
      arguments: { name: "export", value: evidence.path, evidenceRefs: [`step:${evidence.step}`] },
    });
    assert.notEqual(published.isError, true, JSON.stringify(published));
    const checkpoint = await client.callTool({
      name: "checkpoint",
      arguments: { name: "downloaded", evidenceRefs: [`step:${evidence.step}`] },
    });
    assert.notEqual(checkpoint.isError, true, JSON.stringify(checkpoint));
    const duplicate = await client.callTool({
      name: "checkpoint",
      arguments: { name: "downloaded", evidenceRefs: [`step:${evidence.step}`] },
    });
    assert.equal(duplicate.isError, true);
    await client.callTool({
      name: "done",
      arguments: { outcome: "blocked", summary: "Subsequent check requires another account" },
    });
    const transcript = readNdjson<TranscriptEntry>(
      path.join(directory, "browser-transcript.ndjson"),
    );
    validateCheckpoints(
      { checkpoints: context.checkpoints! },
      JSON.parse(fs.readFileSync(path.join(directory, "checkpoints.json"), "utf8")),
      transcript,
    );
    validateOutputs(
      { outputs: context.outputs! },
      JSON.parse(fs.readFileSync(path.join(directory, "outputs.json"), "utf8")),
      transcript,
      files,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "blocked",
    );
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
