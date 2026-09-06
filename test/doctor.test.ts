import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctor, supportedNodeVersion } from "../src/doctor.js";

test("doctor enforces the package's Node 20.19 minimum", () => {
  assert.equal(supportedNodeVersion("19.99.0"), false);
  assert.equal(supportedNodeVersion("20.0.0"), false);
  assert.equal(supportedNodeVersion("20.11.99"), false);
  assert.equal(supportedNodeVersion("20.12.0"), false);
  assert.equal(supportedNodeVersion("20.18.99"), false);
  assert.equal(supportedNodeVersion("20.19.0"), true);
  assert.equal(supportedNodeVersion("21.0.0"), true);
});

test("doctor makes unselected providers and an unused browser informational", () => {
  const isolatedPath = fs.mkdtempSync(path.join(os.tmpdir(), "aek-doctor-empty-path-"));
  const originalPath = process.env.PATH;
  process.env.PATH = isolatedPath;
  try {
    const discovered = doctor();
    assert.equal(discovered.find((check) => check.name === "codex binary")?.required, false);
    assert.equal(discovered.find((check) => check.name === "playwright chromium")?.required, false);
    assert.equal(
      discovered.find((check) => check.name === "supported subscription provider")?.ok,
      false,
    );

    const selected = doctor({ providers: ["codex"], requireBrowser: false });
    assert.equal(selected.find((check) => check.name === "codex binary")?.required, true);
    assert.equal(selected.find((check) => check.name === "playwright chromium")?.required, false);
    assert.equal(
      selected.some((check) => check.name === "supported subscription provider"),
      false,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(isolatedPath, { recursive: true, force: true });
  }
});

test("doctor requires Grok subscription auth from the provider's resolved home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-doctor-grok-auth-"));
  const bin = path.join(root, "bin");
  const grokHome = path.join(root, "grok-home");
  fs.mkdirSync(bin);
  fs.mkdirSync(grokHome);
  const fakeGrok = path.join(bin, "grok");
  fs.writeFileSync(
    fakeGrok,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) console.log("grok test");
else if (process.argv.includes("inspect")) console.log("{}");
`,
  );
  fs.chmodSync(fakeGrok, 0o755);

  const originalPath = process.env.PATH;
  const originalGrokHome = process.env.GROK_HOME;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.GROK_HOME = grokHome;
  try {
    const missing = doctor({ providers: ["grok"] });
    assert.equal(missing.find((check) => check.name === "grok local profile")?.ok, true);
    assert.equal(missing.find((check) => check.name === "grok subscription auth")?.ok, false);

    fs.writeFileSync(path.join(grokHome, "auth.json"), "{}\n", { mode: 0o600 });
    const authenticated = doctor({ providers: ["grok"] });
    assert.equal(authenticated.find((check) => check.name === "grok subscription auth")?.ok, true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
