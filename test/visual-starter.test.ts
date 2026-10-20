import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { initializeProject } from "../src/templates.js";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { promoteBaseline } from "../src/baselines.js";
import { assertArtifactIntegrity } from "../src/integrity.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("visual starter calibrates real WebGL and Canvas2D, then keeps model comparisons independent and honest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-visual-starter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject(root, "visual");
  const configFile = path.join(root, "evalkit.yaml");
  const raw = YAML.parse(fs.readFileSync(configFile, "utf8"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  raw.target.url = url;
  raw.target.ready.url = url;
  raw.target.start = {
    command: "node evals/visual/server.mjs",
    env: { AEK_VISUAL_PORT: String(port) },
  };
  fs.writeFileSync(configFile, YAML.stringify(raw));
  const evaluate = async (renderer: string, variant: string, suite = "checks") => {
    const config = loadConfig(configFile, {
      suite,
      judgeProvider: "mock",
      targetUrl: `${url}?renderer=${renderer}&variant=${variant}`,
    });
    const result = await runEvaluation({
      config,
      configFile,
      specs: loadSpecs(config.paths.specs),
      fixtures: {},
      split: "all",
    });
    assertArtifactIntegrity(result.runDir, { require: true });
    assert(result.report);
    return { ...result, report: result.report, config };
  };
  let working: Awaited<ReturnType<typeof evaluate>> | undefined;
  for (const renderer of ["webgl", "canvas"]) {
    for (const variant of ["working", "frozen", "blank"]) {
      const result = await evaluate(renderer, variant);
      const area = result.report.areas[0]!;
      assert.equal(result.report.overallCoveragePct, 100, `${renderer}/${variant}`);
      assert.equal(result.report.gates.passed, variant === "working", `${renderer}/${variant}`);
      assert.equal(area.items[0]!.verdict, variant === "working" ? "pass" : "fail");
      const checks = area.scenarios[0]!.captureChecks!;
      if (variant === "frozen")
        assert(checks.some((check) => check.name.includes("minimumMovement") && !check.pass));
      if (variant === "blank")
        assert(checks.some((check) => check.name.includes("imageHealth") && !check.pass));
      if (renderer === "webgl" && variant === "working") working = result;
    }
  }
  assert(working);
  promoteBaseline({
    config: working.config,
    runDir: working.runDir,
    name: "approved",
    reviewer: "visual-starter-test",
    includeImages: true,
  });
  for (const suite of ["baseline", "aspirational"]) {
    const result = await evaluate("webgl", "working", suite);
    assert.equal(result.report.areas[0]!.items[0]!.verdict, "pass");
    assert.equal(result.report.areas[0]!.items[1]!.verdict, "cannot_judge");
    assert.equal(result.report.areas[0]!.items[2]!.id, "UI_CLARITY");
    assert.equal(result.report.areas[0]!.items[2]!.verdict, "cannot_judge");
    assert.equal(result.report.gates.passed, false);
    assert.equal(result.report.overallCoveragePct, 33.333);
  }
});

test("visual initialization refuses a nested helper conflict without publishing a partial kit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-visual-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "evals/visual/scene.mjs");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "user-owned\n");
  assert.throws(() => initializeProject(root, "visual"), /Refusing to overwrite/);
  assert.equal(fs.existsSync(path.join(root, "evalkit.yaml")), false);
  assert.equal(fs.existsSync(path.join(root, "evals/specs")), false);
  assert.equal(fs.readFileSync(helper, "utf8"), "user-owned\n");
});
