import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserMcpLaunch } from "../src/mcp-config.js";
import { writeJson, readNdjson } from "../src/io.js";
import type { BrowserMcpContext } from "../src/browser/context.js";
import type { TranscriptEntry } from "../src/types.js";

for (const phase of ["before", "after"] as const) {
  for (const failure of ["origin", "execution"] as const) {
    test(`${phase}-capture session boundary ${failure} exception survives completion retries`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-terminal-boundary-"));
      const server = http.createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end("<h1>Account</h1>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}`;
      const candidate = path.join(directory, "candidate.json");
      const contextFile = path.join(directory, "context.json");
      writeJson(contextFile, {
        targetUrl: url,
        allowedOrigins: [url],
        evidenceDir: directory,
        requiredCheckpoints: [],
        fixtureFiles: {},
        expectAuthenticated: false,
        headless: true,
        viewport: { width: 800, height: 600 },
        actionTimeoutMs: 2000,
        storageStateCandidatePath: candidate,
      } satisfies BrowserMcpContext);
      const launch = browserMcpLaunch(contextFile);
      const entry = launch.args.at(-2)!;
      const entryUrl = pathToFileURL(entry);
      const extension = entry.endsWith(".ts") ? "ts" : "js";
      const loader = path.join(directory, "inject.mjs");
      const activate = path.join(directory, "activate");
      // Fail exactly once after normal navigation so an ignored exception would
      // let a subsequent done call save state and falsely report completion.
      fs.writeFileSync(
        loader,
        `
import fs from "node:fs";
import { BrowserSession } from ${JSON.stringify(new URL(`session.${extension}`, entryUrl).href)};
import { OriginBoundaryError, BrowserEvidenceError } from ${JSON.stringify(new URL(`interaction-context.${extension}`, entryUrl).href)};
const original = BrowserSession.prototype.preflightOrigin;
let checks = 0;
BrowserSession.prototype.preflightOrigin = async function() {
  if (fs.existsSync(${JSON.stringify(activate)}) && ++checks === ${phase === "before" ? 1 : 2}) {
    throw ${failure === "origin" ? "new OriginBoundaryError('BLOCKED: Origin recovery failed')" : "new BrowserEvidenceError('Could not inspect browser boundary')"};
  }
  return original.call(this);
};
await import(${JSON.stringify(entryUrl.href)});
`,
      );
      const client = new Client({ name: "terminal-boundary", version: "1" });
      const transport = new StdioClientTransport({
        command: launch.command,
        args: [...launch.args.slice(0, -2), loader, contextFile],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        assert.notEqual(
          (await client.callTool({ name: "navigate", arguments: { url } })).isError,
          true,
        );
        fs.writeFileSync(activate, "");
        const done = {
          name: "done",
          arguments: { outcome: "completed", summary: "Agent claims success" },
        };
        await client.callTool(done);
        const retry = await client.callTool(done);
        assert.equal(retry.isError, true);
        assert.equal(fs.existsSync(candidate), false);
        const resultFile = path.join(directory, "browser-result.json");
        const errorFile = path.join(directory, "browser-error.json");
        if (failure === "origin") {
          assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).outcome, "blocked");
          assert.equal(fs.existsSync(errorFile), false);
        } else {
          assert.equal(fs.existsSync(resultFile), false);
          assert.match(
            JSON.parse(fs.readFileSync(errorFile, "utf8")).error,
            /Could not inspect browser boundary/,
          );
        }
        const transcript = readNdjson<TranscriptEntry>(
          path.join(directory, "browser-transcript.ndjson"),
        );
        assert.deepEqual(
          transcript.map((entry) => entry.tool),
          ["navigate", "done", "done"],
        );
        assert.deepEqual(
          transcript.map((entry) => entry.step),
          [1, 2, 3],
        );
      } finally {
        await client.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const phase of ["automatic", "terminal"] as const) {
  for (const failure of ["credential", "inspection", "write"] as const) {
    test(`${phase} capture ${failure} failure cannot finalize successfully or save a session`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-evidence-failfast-"));
      const server = http.createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end("<h1>Account</h1>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}`;
      const candidate = path.join(directory, "candidate.json");
      const contextFile = path.join(directory, "context.json");
      writeJson(contextFile, {
        targetUrl: url,
        allowedOrigins: [url],
        evidenceDir: directory,
        checkpoints: { saved: "Saved content" },
        requiredCheckpoints: phase === "terminal" ? ["saved"] : [],
        fixtureFiles: {},
        expectAuthenticated: false,
        headless: true,
        viewport: { width: 800, height: 600 },
        actionTimeoutMs: 2000,
        storageStateCandidatePath: candidate,
      } satisfies BrowserMcpContext);
      const launch = browserMcpLaunch(contextFile);
      const entry = launch.args.at(-2)!;
      const entryUrl = pathToFileURL(entry);
      const extension = entry.endsWith(".ts") ? "ts" : "js";
      const loader = path.join(directory, "inject.mjs");
      // Inject a typed failure at the screenshot boundary, retaining the real
      // browser, MCP transport, metadata writes and terminal-state handling.
      fs.writeFileSync(
        loader,
        `
import { BrowserSession } from ${JSON.stringify(new URL(`session.${extension}`, entryUrl).href)};
import { AuthenticationEvidenceError, BrowserEvidenceError } from ${JSON.stringify(new URL(`interaction-context.${extension}`, entryUrl).href)};
const original = BrowserSession.prototype.screenshot;
BrowserSession.prototype.screenshot = async function(label, ...args) {
  if (${JSON.stringify(failure)} !== 'write' && (${JSON.stringify(phase)} === 'automatic' ? label.startsWith('auto-') : label === 'final-state')) {
    throw ${failure === "credential" ? "new AuthenticationEvidenceError('Authentication credential remains in DOM')" : "new BrowserEvidenceError('Could not inspect frame credentials')"};
  }
  return original.call(this, label, ...args);
};
await import(${JSON.stringify(entryUrl.href)});
`,
      );
      const transport = new StdioClientTransport({
        command: launch.command,
        args: [...launch.args.slice(0, -2), loader, contextFile],
        stderr: "pipe",
      });
      const client = new Client({ name: "failfast-test", version: "1" });
      const breakMetadata = () => {
        fs.rmSync(path.join(directory, "screenshots.json"), { force: true });
        fs.mkdirSync(path.join(directory, "screenshots.json"));
      };
      try {
        await client.connect(transport);
        if (phase === "automatic" && failure === "write") breakMetadata();
        const navigation = await client.callTool({ name: "navigate", arguments: { url } });
        assert.equal(navigation.isError === true, phase === "automatic");
        if (phase === "terminal" && failure === "write") breakMetadata();
        if (phase === "terminal") {
          const premature = await client.callTool({
            name: "done",
            arguments: { outcome: "completed", summary: "Checkpoint still missing" },
          });
          assert.equal(premature.isError, true);
          assert.match(
            JSON.stringify(premature.content),
            /missing rubric-required checkpoints: saved/,
          );
          assert.equal(fs.existsSync(candidate), false);
          assert.equal(fs.existsSync(path.join(directory, "browser-error.json")), false);
          assert.equal(fs.existsSync(path.join(directory, "browser-result.json")), false);
          const checkpoint = await client.callTool({
            name: "checkpoint",
            arguments: { name: "saved", evidenceRefs: ["step:1"] },
          });
          assert.notEqual(checkpoint.isError, true);
        }
        const done = await client.callTool({
          name: "done",
          arguments: { outcome: "completed", summary: "Agent claims success" },
        });
        assert.equal(fs.existsSync(candidate), false);
        const resultFile = path.join(directory, "browser-result.json");
        if (failure === "credential") {
          assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).outcome, "blocked");
          assert.equal(fs.existsSync(path.join(directory, "browser-error.json")), false);
        } else {
          assert.equal(done.isError, true);
          assert.equal(fs.existsSync(resultFile), false);
          assert.ok(
            JSON.parse(fs.readFileSync(path.join(directory, "browser-error.json"), "utf8")).error,
          );
        }
        const next = await client.callTool({ name: "wait", arguments: { ms: 1 } });
        assert.equal(next.isError, true);
        const transcript = readNdjson<TranscriptEntry>(
          path.join(directory, "browser-transcript.ndjson"),
        );
        assert.equal(new Set(transcript.map((entry) => entry.step)).size, transcript.length);
      } finally {
        await client.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
