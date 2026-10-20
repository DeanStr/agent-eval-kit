import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drainProcessRegistry } from "../src/process-registry.js";

test("invalid process registries fail before signaling any group", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signal = t.mock.method(process, "kill", () => true);
  const file = path.join(root, "processes.json");
  for (const invalid of [{}, [0], [-1], [1.5], ["2"], [null], [1, 0]]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    await assert.rejects(drainProcessRegistry(file), /Invalid process group registry/);
  }
  assert.equal(signal.mock.callCount(), 0);
});
