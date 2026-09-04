import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { captureAuth, personaAuthPath } from "../src/auth.js";
import type { EvalConfig } from "../src/types.js";

test("persona auth paths remain distinct after filename sanitization and truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-auth-path-"));
  const config = {
    target: { url: "https://app.example.test" },
    paths: { auth: path.join(root, "auth") },
  } as EvalConfig;
  assert.notEqual(personaAuthPath(config, "ops/a"), personaAuthPath(config, "ops?a"));
  assert.notEqual(
    personaAuthPath(config, `${"a".repeat(120)}-first`),
    personaAuthPath(config, `${"a".repeat(120)}-second`),
  );
  assert.match(path.basename(personaAuthPath(config, "buyer")), /^buyer-[a-f0-9]{64}\.json$/);
  const httpsPath = personaAuthPath(config, "buyer");
  config.target.url = "http://app.example.test";
  assert.notEqual(personaAuthPath(config, "buyer"), httpsPath);
  fs.rmSync(root, { recursive: true, force: true });
});

test("auth capture preserves interactive visibility and honors automated headless configuration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-auth-headless-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Auth", root },
    target: { kind: "web", url: "http://127.0.0.1:1", allowedOrigins: ["http://127.0.0.1:1"] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const launches: Array<boolean | undefined> = [];
  t.mock.method(chromium, "launch", async (options: Parameters<typeof chromium.launch>[0]) => {
    launches.push(options?.headless);
    throw new Error("launch intercepted");
  });
  try {
    await assert.rejects(captureAuth({ config, persona: "automated", clickText: "Sign in" }), /launch intercepted/);
    config.browser.headless = false;
    await assert.rejects(captureAuth({ config, persona: "headed-automated", clickText: "Sign in" }), /launch intercepted/);
    config.browser.headless = true;
    await assert.rejects(captureAuth({ config, persona: "interactive" }), /launch intercepted/);
    assert.deepEqual(launches, [true, false, false]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automated auth capture fails closed when its requested click fails", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <button>Demo login</button>
      <div style="position:fixed;inset:0;z-index:2;background:white">Loading</div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-auth-click-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Auth", root },
    target: { kind: "web", url, allowedOrigins: [url] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  try {
    await assert.rejects(
      captureAuth({ config, persona: "demo", clickText: "Demo login" }),
      /Auth capture click failed: ERROR:.*covering it/,
    );
    assert.equal(fs.existsSync(personaAuthPath(config, "demo")), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auth capture permits a temporary OAuth popup and saves only application state", async () => {
  let applicationUrl = "";
  let providerUrl = "";
  const application = http.createServer((request, response) => {
    if (request.url === "/done") {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "app_session=authenticated; Path=/; HttpOnly",
      });
      response.end("<!doctype html><p>Authenticated</p>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><button onclick="window.open('${providerUrl}/authorize')">Sign in with OAuth</button>`);
  });
  const provider = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "identity_provider_session=private; Path=/; HttpOnly",
    });
    response.end(`<!doctype html><p>Identity provider</p><script>
      setTimeout(() => {
        window.opener.location.href = ${JSON.stringify(`${applicationUrl}/done`)};
        window.close();
      }, 400);
    </script>`);
  });
  await new Promise<void>((resolve) => application.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => provider.listen(0, resolve));
  const applicationAddress = application.address();
  const providerAddress = provider.address();
  assert.ok(applicationAddress && typeof applicationAddress !== "string");
  assert.ok(providerAddress && typeof providerAddress !== "string");
  applicationUrl = `http://127.0.0.1:${applicationAddress.port}`;
  providerUrl = `http://localhost:${providerAddress.port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-auth-oauth-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "OAuth", root },
    target: { kind: "web", url: applicationUrl, allowedOrigins: [applicationUrl] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 2_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  try {
    const saved = await captureAuth({ config, persona: "oauth-user", clickText: "Sign in with OAuth" });
    const state = JSON.parse(fs.readFileSync(saved, "utf8"));
    assert.deepEqual(state.cookies.map((cookie: { name: string }) => cookie.name), ["app_session"]);
    assert.ok(state.origins.every((origin: { origin: string }) => origin.origin === applicationUrl));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(config.paths.auth).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(saved)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    }
  } finally {
    application.close();
    provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
