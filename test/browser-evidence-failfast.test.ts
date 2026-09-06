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
