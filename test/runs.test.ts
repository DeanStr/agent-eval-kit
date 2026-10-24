import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RUN_LOCK_ACQUISITION_DIRECTORY, withRunLock, type RunState } from "../src/run/state.js";
import { listRuns } from "../src/run-references.js";
import { pruneRuns } from "../src/runs.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-prune-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (runId: string, overrides: Partial<RunState> = {}) => {
    const directory = path.join(root, runId);
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "run-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        status: "complete",
        pid: 2147483647,
        configFile: path.join(root, "evalkit.yaml"),
        startedAt: "2026-01-01T00:00:00Z",
        selectedAreas: ["core"],
        specHashes: {},
        inputFingerprint: "fixture",
        ...overrides,
      } satisfies RunState),
    );
    fs.writeFileSync(path.join(directory, "evidence.txt"), "Retained evidence\n");
    return directory;
  };
  return { root, add };
}

test("pruning preserves active, stale, malformed, and partially acquired run locks", async (t) => {
  const { root, add } = fixture(t);
  const active = add("active");
  const stale = add("stale", { status: "running" });
  fs.writeFileSync(
    path.join(stale, ".run.lock"),
    JSON.stringify({ pid: 2147483647, token: "stale" }),
  );
  const malformed = add("malformed");
  fs.writeFileSync(path.join(malformed, ".run.lock"), "unfinished lock");
  const acquiring = add("acquiring");
  fs.mkdirSync(path.join(acquiring, RUN_LOCK_ACQUISITION_DIRECTORY));
  const dangling = add("dangling");
  fs.symlinkSync(path.join(root, "missing-lock"), path.join(dangling, ".run.lock"));
  add("live-state", { status: "running", pid: process.pid });
  await withRunLock(active, () => {
    for (const dryRun of [true, false]) {
      const result = pruneRuns(root, { keep: 0, dryRun });
      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.skippedLocked.sort(), [
        "acquiring",
        "active",
        "dangling",
        "malformed",
        "stale",
      ]);
      assert.deepEqual(result.skippedActive, ["live-state"]);
      assert.equal(result.kept, 6);
    }
  });
  assert.ok(fs.existsSync(path.join(stale, ".run.lock")));
  assert.ok(fs.existsSync(path.join(acquiring, RUN_LOCK_ACQUISITION_DIRECTORY)));
  assert.equal(fs.existsSync(path.join(active, RUN_LOCK_ACQUISITION_DIRECTORY)), false);
  assert.equal(listRuns(root).length, 6);
});

test("pruning excludes a concurrent writer throughout inspection and removes the run from history", async (t) => {
  const { root, add } = fixture(t);
  const directory = add("run");
  const read = fs.readdirSync;
  let contender: Promise<void> | undefined;
  t.mock.method(fs, "readdirSync", ((target, options) => {
    if (String(target) === directory && !contender)
      contender = assert.rejects(
        withRunLock(directory, () => assert.fail("writer entered during pruning")),
        /acquisition is in progress/,
      );
    return Reflect.apply(read, fs, [target, options]);
  }) as typeof fs.readdirSync);
  const result = pruneRuns(root, { keep: 0, dryRun: false });
  assert.ok(contender, "attempted a concurrent write while counting the run's bytes");
  await contender;
  assert.deepEqual(
    result.deleted.map((run) => run.runId),
    ["run"],
  );
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(listRuns(root), []);
  assert.deepEqual(fs.readdirSync(path.join(root, ".pruning")), []);
});

test("pruning releases its guard and reports staged artifacts when deletion fails", (t) => {
  const { root, add } = fixture(t);
  const directory = add("run");
  const remove = fs.rmSync;
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target).startsWith(path.join(root, ".pruning") + path.sep))
      throw new Error("fixture disk failure");
    return remove(target, options);
  });
  assert.throws(
    () => pruneRuns(root, { keep: 0, dryRun: false }),
    /moved to .*\.pruning.*deletion failed: fixture disk failure/,
  );
  assert.equal(fs.existsSync(directory), false);
  const [staged] = fs.readdirSync(path.join(root, ".pruning"));
  const retained = path.join(root, ".pruning", staged!);
  assert.equal(fs.readFileSync(path.join(retained, "evidence.txt"), "utf8"), "Retained evidence\n");
  assert.equal(fs.existsSync(path.join(retained, RUN_LOCK_ACQUISITION_DIRECTORY)), false);
});
