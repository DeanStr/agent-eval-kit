import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageCredentials } from "../src/providers/credentials.js";

test("isolated OAuth refreshes persist for the next invocation without overwriting a concurrent login", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-credential-refresh-"));
  const source = path.join(root, "credentials.json");
  const isolated = path.join(root, "isolated.json");
  try {
    fs.writeFileSync(source, JSON.stringify({ refresh: "old-test-value" }), { mode: 0o600 });
    const save = stageCredentials(source, isolated);
    fs.writeFileSync(isolated, JSON.stringify({ refresh: "rotated-test-value" }));
    save();
    assert.deepEqual(JSON.parse(fs.readFileSync(source, "utf8")), {
      refresh: "rotated-test-value",
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(source).mode & 0o777, 0o600);

    const saveSecond = stageCredentials(source, isolated);
    fs.writeFileSync(isolated, JSON.stringify({ refresh: "second-rotation" }));
    fs.writeFileSync(source, JSON.stringify({ refresh: "new-login" }));
    saveSecond();
    assert.deepEqual(JSON.parse(fs.readFileSync(source, "utf8")), { refresh: "new-login" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed refreshed credentials cannot replace working credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-credential-invalid-"));
  const source = path.join(root, "credentials.json");
  const isolated = path.join(root, "isolated.json");
  try {
    fs.writeFileSync(source, '{"refresh":"valid-test-value"}');
    const original = fs.readFileSync(source);
    const save = stageCredentials(source, isolated);
    fs.writeFileSync(isolated, "null");
    assert.throws(save, /invalid refreshed credential/);
    assert.deepEqual(fs.readFileSync(source), original);
    fs.writeFileSync(isolated, "invalid-secret-content");
    assert.throws(
      save,
      (error) =>
        error instanceof Error &&
        /invalid refreshed credential JSON/.test(error.message) &&
        !error.message.includes("invalid-secret-content"),
    );
    assert.deepEqual(fs.readFileSync(source), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
