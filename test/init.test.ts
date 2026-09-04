import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../src/templates.js";

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "aek-init-test-"));

test("project initialization publishes the complete starter kit without staging debris", () => {
  const root = temporary();
  const files = initializeProject(root);
  assert.deepEqual(files, [
    path.join(root, "evalkit.yaml"),
    path.join(root, "evals", "specs", "core.yaml"),
    path.join(root, "evals", "fixtures.yaml"),
  ]);
  assert(files.every((file) => fs.statSync(file).isFile()));
  assert.deepEqual(
    fs.readdirSync(path.join(root, "evals", "specs")).filter((name) => name.includes(".aek-init-")),
    [],
  );
});

test("project initialization preflights every conflict before writing anything", () => {
  const root = temporary();
  const conflict = path.join(root, "evals", "specs", "core.yaml");
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.writeFileSync(conflict, "user-owned\n");
  assert.throws(() => initializeProject(root), /Refusing to overwrite existing files/);
  assert.equal(fs.existsSync(path.join(root, "evalkit.yaml")), false);
  assert.equal(fs.existsSync(path.join(root, "evals", "fixtures.yaml")), false);
  assert.equal(fs.readFileSync(conflict, "utf8"), "user-owned\n");
});
