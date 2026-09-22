import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("worked adapter reuses Node tests without confusing failures, missing evidence, and errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-test-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const example = path.resolve(import.meta.dirname, "../examples/authoring");
  const product = fs.readFileSync(path.join(example, "cart.mjs"), "utf8");
  const tests = fs.readFileSync(path.join(example, "cart.test.mjs"), "utf8");
  fs.copyFileSync(path.join(example, "test-adapter.mjs"), path.join(root, "test-adapter.mjs"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const cases = [
    {
      name: "passing tests and noisy stdout",
      tests: `${tests}\nconsole.log('runner log');`,
      verdict: "pass",
    },
    {
      name: "assertion failure",
      product: product.replace(" * line.quantity", ""),
      verdict: "fail",
    },
    { name: "required skip", tests: tests.replace("test(", "test.skip("), verdict: "cannot_judge" },
    { name: "required todo", tests: tests.replace("test(", "test.todo("), verdict: "cannot_judge" },
    { name: "no tests", tests: "", verdict: null },
    {
      name: "missing test",
      tests: tests.replace('"empty cart totals zero"', '"renamed"'),
      verdict: null,
    },
    {
      name: "duplicate test",
      tests: `${tests}\ntest('empty cart totals zero', () => {});`,
      verdict: null,
    },
    { name: "import error", product: "throw new Error('missing dependency');", verdict: null },
    {
      name: "hook assertion is an error",
      tests: `${tests}\nimport { beforeEach } from 'node:test';\nbeforeEach(() => assert.fail('broken setup'));`,
      verdict: null,
    },
    {
      name: "runner error overrides product failure",
      product:
        "export function total(lines) { if (!lines.length) throw new Error('broken setup'); return 0; }",
      verdict: null,
    },
    {
      name: "timeout",
      tests: tests.replace(
        'test("empty cart totals zero", () => {',
        'test("empty cart totals zero", { timeout: 10 }, async () => { await new Promise(resolve => setTimeout(resolve, 100));',
      ),
      verdict: null,
    },
    {
      name: "late process failure",
      tests: `${tests}\nprocess.on('beforeExit', () => { process.exitCode = 1; });`,
      verdict: null,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      fs.writeFileSync(path.join(root, "cart.mjs"), entry.product ?? product);
      fs.writeFileSync(path.join(root, "cart.test.mjs"), entry.tests ?? tests);
      const result = spawnSync(process.execPath, [path.join(root, "test-adapter.mjs")], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, entry.verdict === null ? 1 : 0, result.stderr);
      if (entry.verdict === null) {
        assert.equal(result.stdout, "", "execution errors must not emit a verdict");
        assert.ok(result.stderr.length > 0);
      } else {
        const output = JSON.parse(result.stdout);
        assert.equal(output.verdict, entry.verdict, result.stderr);
        assert.ok(output.reasoning.length > 0);
        if (entry.name === "passing tests and noisy stdout")
          assert.match(result.stderr, /runner log/);
      }
    });
  }
});
