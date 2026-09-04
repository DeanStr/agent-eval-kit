import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTimestampedDirectory, readNdjson, safeName } from "../src/io.js";

test("safe artifact names retain uniqueness beyond the filename limit", () => {
  const prefix = "a".repeat(100);
  const first = safeName(`${prefix}-first`);
  const second = safeName(`${prefix}-second`);
  assert.notEqual(first, second);
  assert.ok(first.length <= 100);
  assert.ok(second.length <= 100);
  assert.match(safeName("ordinary-id"), /^ordinary-id$/);
});

test("malformed NDJSON fails with the physical line number", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-ndjson-"));
  const file = path.join(root, "events.ndjson");
  fs.writeFileSync(file, '{"ok":true}\n\nnot-json\n');
  assert.throws(() => readNdjson(file), /Invalid NDJSON .* at line 3/);
});

test("timestamped artifact directories are exclusively reserved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-timestamp-dirs-"));
  const directories = Array.from({ length: 20 }, () => createTimestampedDirectory(root));
  assert.equal(new Set(directories).size, directories.length);
  assert.ok(directories.every((directory) => fs.statSync(directory).isDirectory()));
});
