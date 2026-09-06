import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserMcpLaunch } from "../src/mcp-config.js";
import { writeJson } from "../src/io.js";
import type { BrowserMcpContext } from "../src/browser/context.js";
import type { ScreenshotRef, TranscriptEntry } from "../src/types.js";

test("persona switching isolates identities, preserves live contexts, invalidates refs and records provenance", async () => {
  let slowStarted!: () => void;
  const slowRequest = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  let releaseSlow!: () => void;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const identity = /identity=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "anonymous";
    const finish = () =>
      response.end(
        `<h1>Identity ${identity}</h1><button onclick="sessionStorage.setItem('remember','yes');this.textContent='Remembered'">Remember</button>`,
      );
    if (request.url === "/slow") {
      releaseSlow = finish;
      slowStarted();
    } else finish();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-personas-"));
  const personas: NonNullable<BrowserMcpContext["personas"]> = {
    anonymous: {},
    missing: { storageStatePath: path.join(directory, "missing.json") },
  };
  for (const name of ["organizer", "reviewer"]) {
    const file = path.join(directory, `${name}.json`);
    writeJson(file, {
      cookies: [
        {
          name: "identity",
          value: name,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
    personas[name] = {
      storageStatePath: file,
      candidatePath: path.join(directory, `${name}.candidate.json`),
    };
  }
  const context: BrowserMcpContext = {
    targetUrl: url,
    allowedOrigins: [url],
    evidenceDir: directory,
    persona: "organizer",
    personas,
    outputs: { recordUrl: { type: "url" } },
    fixtureFiles: {},
    expectAuthenticated: true,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 1000,
  };
  const contextFile = path.join(directory, "context.json");
  writeJson(contextFile, context);
  const launch = browserMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "persona-test", version: "1" });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);
  try {
    await client.connect(transport);
    const first = await call("navigate", { url });
    assert.match(text(first), /Identity organizer/);
    const ref = /\[(e\d+)\].*?<button/.exec(text(first))?.[1];
    assert.ok(ref, text(first));
    const clicked = await call("click", { ref });
    assert.notEqual(clicked.isError, true, text(clicked));
    const published = await call("publish_output", {
      name: "recordUrl",
      value: `${url}/records/42`,
      evidenceRefs: ["step:1"],
    });
    assert.notEqual(published.isError, true, text(published));
    assert.equal(
      (
        await call("publish_output", {
          name: "recordUrl",
          value: `${url}/?token=secret`,
          evidenceRefs: ["step:1"],
        })
      ).isError,
      true,
    );
    assert.equal((await call("switch_persona", { persona: "undeclared" })).isError, true);
    assert.notEqual((await call("switch_persona", { persona: "reviewer" })).isError, true);
    assert.match(text(await call("navigate", { url })), /Identity reviewer/);
    assert.equal((await call("click", { ref })).isError, true);
    await call("switch_persona", { persona: "anonymous" });
    assert.match(text(await call("navigate", { url })), /Identity anonymous/);
    await call("switch_persona", { persona: "organizer" });
    assert.equal((await call("click", { ref })).isError, true);
    const restored = text(await call("snapshot"));
    assert.match(restored, /Identity organizer/);
    assert.match(restored, /Remembered/);
    const navigating = call("navigate", { url: `${url}/slow` });
    await slowRequest;
    const switching = call("switch_persona", { persona: "reviewer" });
    // Hold the organizer action open while the switch request reaches the server.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseSlow();
    const [navigated, switched] = await Promise.all([navigating, switching]);
    assert.match(text(navigated), /Identity organizer/);
    assert.notEqual(switched.isError, true, text(switched));
    await call("done", { outcome: "completed", summary: "Cross-role checks completed" });
    for (const name of ["organizer", "reviewer"]) {
      const candidate = JSON.parse(
        fs.readFileSync(requireDefined(personas[name], "personas[name]").candidatePath!, "utf8"),
      );
      assert.equal(
        candidate.cookies.find((cookie: { name: string }) => cookie.name === "identity").value,
        name,
      );
    }
    const shots: ScreenshotRef[] = JSON.parse(
      fs.readFileSync(path.join(directory, "screenshots.json"), "utf8"),
    );
    assert.equal(new Set(shots.map((shot) => shot.path)).size, shots.length);
    for (const persona of ["organizer", "reviewer", "anonymous"])
      assert.ok(shots.some((shot) => shot.persona === persona));
    const transcript: TranscriptEntry[] = fs
      .readFileSync(path.join(directory, "browser-transcript.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      transcript.some(
        (entry) =>
          entry.tool === "switch_persona" &&
          entry.input.from === "organizer" &&
          entry.persona === "reviewer",
      ),
    );
    const slowEntry = transcript.find((entry) => entry.input.url === `${url}/slow`)!;
    assert.equal(slowEntry.persona, "organizer");
    assert.equal(
      transcript.find((entry) => entry.step === slowEntry.step + 1)?.tool,
      "switch_persona",
    );
    assert.deepEqual(
      transcript.map((entry) => entry.step),
      transcript.map((_, index) => index + 1),
    );
    assert.equal(shots.find((shot) => shot.url === `${url}/slow`)?.persona, "organizer");
    const missing = await call("switch_persona", { persona: "missing" });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /No saved browser session/);
    await call("done", { outcome: "completed", summary: "Cannot verify missing role" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "blocked",
    );
  } finally {
    await client.close();
    await transport.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function withPersonaFixture(
  run: (fixture: {
    call: (name: string, args?: Record<string, unknown>) => ReturnType<Client["callTool"]>;
    url: string;
    directory: string;
    reviewerState: string;
  }) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/login" ? "<h1>Login</h1>" : "<h1>Application</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-persona-review-"));
  const reviewerState = path.join(directory, "reviewer.json");
  writeJson(reviewerState, { cookies: [], origins: [] });
  const context: BrowserMcpContext = {
    targetUrl: url,
    allowedOrigins: [url],
    evidenceDir: directory,
    persona: "reviewer",
    personas: {
      reviewer: {
        storageStatePath: reviewerState,
        candidatePath: path.join(directory, "candidate.json"),
      },
      anonymous: {},
    },
    fixtureFiles: {},
    expectAuthenticated: true,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 1000,
  };
  const contextFile = path.join(directory, "context.json");
  writeJson(contextFile, context);
  const launch = browserMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "persona-review-test", version: "1" });
  try {
    await client.connect(transport);
    await run({
      call: (name, args = {}) => client.callTool({ name, arguments: args }),
      url,
      directory,
      reviewerState,
    });
  } finally {
    await client.close();
    await transport.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("switching away cannot hide expired persona authentication", async () => {
  await withPersonaFixture(async ({ call, url, directory }) => {
    // One login-wall navigation has not yet reached the two-action streak.
    assert.notEqual((await call("navigate", { url: `${url}/login` })).isError, true);
    const switched = await call("switch_persona", { persona: "anonymous" });
    assert.equal(switched.isError, true);
    assert.match(JSON.stringify(switched.content), /cannot bypass an expired session/);
    await call("done", { outcome: "completed", summary: "Attempted bypass" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "blocked",
    );
    assert.equal(fs.existsSync(path.join(directory, "candidate.json")), false);
  });
});

test("failed persona startup is not cached and leaves the prior identity active", async () => {
  await withPersonaFixture(async ({ call, url, directory, reviewerState }) => {
    await call("switch_persona", { persona: "anonymous" });
    await call("navigate", { url });
    fs.writeFileSync(reviewerState, "not-json");
    assert.equal((await call("switch_persona", { persona: "reviewer" })).isError, true);
    const snapshot = await call("snapshot");
    assert.notEqual(snapshot.isError, true);
    const entries = fs
      .readFileSync(path.join(directory, "browser-transcript.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).persona, "anonymous");
    writeJson(reviewerState, { cookies: [], origins: [] });
    assert.notEqual((await call("switch_persona", { persona: "reviewer" })).isError, true);
    assert.notEqual((await call("navigate", { url })).isError, true);
    await call("done", { outcome: "completed", summary: "Recovered startup" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "completed",
    );
  });
});
