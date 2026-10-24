import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunLogger } from "../src/log.js";

test("the default progress sink prints only the message, including when a tone is supplied", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const printed = t.mock.method(console, "log", () => {});
  const logger = new RunLogger(path.join(root, "run.log"));
  try {
    logger.line("Starting");
    logger.line("Finished", "pass");
  } finally {
    await logger.close();
  }
  assert.deepEqual(
    printed.mock.calls.map((call) => call.arguments.length),
    [1, 1],
  );
  assert.match(printed.mock.calls[0]!.arguments[0], /^\[\d\d:\d\d:\d\d\] Starting$/);
  assert.match(printed.mock.calls[1]!.arguments[0], /^\[\d\d:\d\d:\d\d\] Finished$/);
  assert.equal(
    fs.readFileSync(path.join(root, "run.log"), "utf8"),
    printed.mock.calls.map((call) => call.arguments[0] + "\n").join(""),
  );
});
