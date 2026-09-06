import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserMcpLaunch, workspaceMcpLaunch } from "../src/mcp-config.js";
import { readNdjson, writeJson } from "../src/io.js";
import { validateCheckpoints, requiredCheckpointNames } from "../src/checkpoints.js";
import type { TranscriptEntry, RubricItem } from "../src/types.js";

for (const kind of ["browser", "workspace"] as const) {
  for (const outcome of ["completed", "blocked", "feature_not_found"] as const) {
    test(`${kind} retains rejected checkpoint calls and supports ${outcome} finalization`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-checkpoint-recovery-"));
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><h1>Saved content</h1>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const evidenceDir = path.join(directory, "evidence");
      const contextFile = path.join(directory, "context.json");
      const checkpoints = {
        saved: "Saved content",
        later: "Later stage",
        unused: "Optional observation",
      };
      writeJson(contextFile, {
        checkpoints,
        requiredCheckpoints: ["saved", "later"],
        evidenceDir,
        ...(kind === "browser"
          ? {
              targetUrl: origin,
              allowedOrigins: [origin],
              fixtureFiles: {},
              expectAuthenticated: false,
              headless: true,
              viewport: { width: 800, height: 600 },
              actionTimeoutMs: 5000,
            }
          : { projectRoot: directory }),
      });
      const transport = new StdioClientTransport({
        ...(kind === "browser" ? browserMcpLaunch(contextFile) : workspaceMcpLaunch(contextFile)),
        stderr: "pipe",
      });
      const client = new Client({ name: "checkpoint-recovery", version: "1" });
      const transcriptFile = path.join(evidenceDir, `${kind}-transcript.ndjson`);
      const resultFile = path.join(evidenceDir, `${kind}-result.json`);
      try {
        await client.connect(transport);
        assert.notEqual(
          (
            await client.callTool(
              kind === "browser"
                ? { name: "navigate", arguments: { url: origin } }
                : { name: "list_files", arguments: {} },
            )
          ).isError,
          true,
        );
        for (const args of [
          { name: "saved", evidenceRefs: Array.from({ length: 24 }, () => "step:1") },
          { name: 42, evidenceRefs: "step:1" },
          { name: "saved" },
          { name: "saved", evidenceRefs: ["step:999"] },
          { name: "saved", evidenceRefs: ["step:1", "step:1"] },
          { name: "saved", evidenceRefs: ["step:1"], unexpected: true },
        ]) {
          const result = await client.callTool({ name: "checkpoint", arguments: args });
          assert.equal(result.isError, true);
          const rejected = readNdjson<TranscriptEntry>(transcriptFile).at(-1)!;
          assert.equal(rejected.tool, "checkpoint");
          assert.equal(rejected.isError, true);
          assert.deepEqual(rejected.input, args);
          assert.equal(fs.existsSync(path.join(evidenceDir, "checkpoints.json")), false);
        }
        assert.notEqual(
          (
            await client.callTool({
              name: "checkpoint",
              arguments: {
                name: "saved",
                evidenceRefs: ["step:1"],
              },
            })
          ).isError,
          true,
        );
        const premature = await client.callTool({
          name: "done",
          arguments: {
            outcome: "completed",
            summary: "All checks complete",
          },
        });
        assert.equal(premature.isError, true);
        assert.match(
          JSON.stringify(premature.content),
          /missing rubric-required checkpoints: later/,
        );
        assert.equal(fs.existsSync(resultFile), false);
        assert.equal(readNdjson<TranscriptEntry>(transcriptFile).at(-1)!.tool, "done");
        if (outcome === "completed") {
          assert.notEqual(
            (
              await client.callTool({
                name: "checkpoint",
                arguments: {
                  name: "later",
                  evidenceRefs: ["step:1"],
                },
              })
            ).isError,
            true,
          );
        }
        const final = await client.callTool({
          name: "done",
          arguments: {
            outcome,
            summary:
              outcome === "completed"
                ? "Both required checks recorded"
                : "Later stage unavailable; saved evidence retained",
          },
        });
        assert.notEqual(final.isError, true);
        assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).outcome, outcome);
        const transcript = readNdjson<TranscriptEntry>(transcriptFile);
        assert.deepEqual(
          transcript.map((entry) => entry.step),
          transcript.map((_, index) => index + 1),
        );
        const recorded = validateCheckpoints(
          { checkpoints },
          JSON.parse(fs.readFileSync(path.join(evidenceDir, "checkpoints.json"), "utf8")),
          transcript,
        );
        assert.deepEqual(
          Object.keys(recorded),
          outcome === "completed" ? ["saved", "later"] : ["saved"],
        );
        const finalBytes = fs.readFileSync(resultFile);
        const checkpointBytes = fs.readFileSync(path.join(evidenceDir, "checkpoints.json"));
        for (const call of [
          { name: "observe", arguments: { note: "Late evidence" } },
          { name: "checkpoint", arguments: { name: "unused", evidenceRefs: ["step:1"] } },
          { name: "done", arguments: { outcome: "blocked", summary: "Late replacement" } },
        ]) {
          const rejected = await client.callTool(call);
          assert.equal(rejected.isError, true);
          assert.match(JSON.stringify(rejected.content), /already finalized/);
        }
        assert.deepEqual(fs.readFileSync(resultFile), finalBytes);
        assert.deepEqual(
          fs.readFileSync(path.join(evidenceDir, "checkpoints.json")),
          checkpointBytes,
        );
      } finally {
        await client.close();
        await transport.close();
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test("required checkpoints come only from rubric selectors for the executable scenario", () => {
  const item = (checkpoints: NonNullable<RubricItem["checkpoints"]>): RubricItem => ({
    id: "CHECK",
    criterion: "Checked",
    weight: 1,
    scenarios: ["FLOW"],
    tags: [],
    grader: { type: "llm" },
    passCriteria: "Checked",
    checkpoints,
  });
  assert.deepEqual(
    requiredCheckpointNames(
      [
        item({ FLOW: ["saved"] }),
        item({ FLOW: ["saved", "later"] }),
        item({ "FLOW--other": ["elsewhere"] }),
      ],
      "FLOW",
    ),
    ["saved", "later"],
  );
});
