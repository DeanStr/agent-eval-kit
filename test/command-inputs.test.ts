import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { buildRunReceipt } from "../src/receipts.js";
import { graderMethodInputs, graderMethodPath } from "../src/judging/command-inputs.js";
import { snapshotEvaluationInputs, validateEvaluationInputs } from "../src/run/inputs.js";
import { judgeArea } from "../src/graders.js";
import { writeJson } from "../src/io.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-command-method-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.resolve("examples/first-run"), root, { recursive: true });
  const config = loadConfig(path.join(root, "evalkit.yaml"));
  const specs = loadSpecs(config.paths.specs);
  const checker = path.join(root, "check.mjs");
  const receipt = () => buildRunReceipt({ config, specs, fixtures: {}, split: "development" });
  const prepare = () => {
    const runDir = path.join(config.paths.runs, "test");
    const original = receipt();
    snapshotEvaluationInputs(config, specs, runDir, "development", original);
    writeJson(path.join(runDir, "receipt.json"), original);
    return { runDir, original };
  };
  return { root, config, specs, checker, receipt, prepare };
}

test("checker bytes change compatibility; target bytes do not; offline rescore preserves the original checker", (t) => {
  const { root, config, specs, checker, receipt } = fixture(t);
  const before = receipt();
  fs.appendFileSync(path.join(root, "cart.mjs"), "\n// target revision\n");
  const targetChanged = receipt();
  assert.equal(before.evaluationFingerprint, targetChanged.evaluationFingerprint);
  assert.notEqual(before.inputFingerprint, targetChanged.inputFingerprint);
  fs.writeFileSync(
    checker,
    'console.log(JSON.stringify({verdict:"pass",reasoning:"Always pass"}));\n',
  );
  assert.notEqual(before.evaluationFingerprint, receipt().evaluationFingerprint);
  fs.unlinkSync(checker);
  const rescore = buildRunReceipt({
    config,
    specs,
    fixtures: {},
    split: "development",
    evidenceProvenance: before,
  });
  assert.deepEqual(rescore.inputs.graderMethods, before.inputs.graderMethods);
  assert.equal(rescore.evaluationFingerprint, before.evaluationFingerprint);
  const corrupt = structuredClone(before);
  delete corrupt.inputs.graderMethods!["QUANTITY/check.mjs"];
  assert.throws(
    () =>
      buildRunReceipt({
        config,
        specs,
        fixtures: {},
        split: "development",
        evidenceProvenance: corrupt,
      }),
    /provenance does not match/,
  );
});

test("method declarations fail before execution when missing, duplicated, or unreadable", async (t) => {
  const { config, specs, checker } = fixture(t);
  const file = requireDefined(specs[0], "specs[0]").sourceFile;
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replaceAll("methodFiles: [check.mjs], ", ""));
  assert.throws(() => loadSpecs(config.paths.specs), /methodFiles/);
  fs.writeFileSync(file, original.replaceAll("[check.mjs]", "[check.mjs, check.mjs]"));
  assert.throws(() => loadSpecs(config.paths.specs), /methodFiles must be unique/);
  fs.writeFileSync(file, original);
  fs.unlinkSync(checker);
  await assert.rejects(
    validateEvaluationInputs(config, specs),
    /Command grader method.*unavailable/,
  );
  fs.mkdirSync(checker);
  assert.throws(() => graderMethodInputs(config, specs), /Command grader method.*invalid/);
});

test("checker and snapshot mutation are rejected before launch, and self-modification is an execution error", async (t) => {
  for (const mutation of ["checker", "snapshot", "during"] as const) {
    await t.test(mutation, async (t) => {
      const { root, config, specs, checker, prepare } = fixture(t);
      const sentinel = path.join(root, "launched");
      const source = `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(sentinel)}, 'yes');\n${mutation === "during" ? "fs.appendFileSync(import.meta.filename, '// changed');" : ""}\nconsole.log(JSON.stringify({verdict:'pass',reasoning:'Observed'}));\n`;
      fs.writeFileSync(checker, source);
      const { runDir } = prepare();
      if (mutation === "checker") fs.appendFileSync(checker, "\n// changed before launch\n");
      if (mutation === "snapshot") {
        const snapshot = graderMethodPath(runDir, "QUANTITY/check.mjs");
        fs.chmodSync(snapshot, 0o600);
        fs.appendFileSync(snapshot, "\n// corrupt snapshot\n");
      }
      await assert.rejects(
        judgeArea({
          commands: { mode: "execute" },
          config,
          spec: requireDefined(specs[0], "specs[0]"),
          evidence: [],
          runDir,
          areaDirectory: path.join(runDir, "areas/cart"),
        }),
        /Command grader method changed/,
      );
      assert.equal(fs.existsSync(sentinel), mutation === "during");
    });
  }
});

test("snapshot rejects a configured fixture that disappears after receipt creation", (t) => {
  const { root, config, specs, receipt } = fixture(t);
  config.paths.fixtures = path.join(root, "fixtures.json");
  fs.writeFileSync(config.paths.fixtures, "{}");
  const original = receipt();
  fs.unlinkSync(config.paths.fixtures);
  assert.throws(
    () =>
      snapshotEvaluationInputs(config, specs, path.join(root, "snapshot"), "development", original),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      error.message.includes("fixtures.json"),
  );
});
