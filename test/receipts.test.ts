import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright";
import { buildRunReceipt } from "../src/receipts.js";
import { captureSchema } from "../src/visual/contracts.js";
import type { EvalConfig, EvalSpec } from "../src/types.js";

function inputs(root: string): { config: EvalConfig; spec: EvalSpec; fixtures: unknown; fixtureData: string } {
  const specFile = path.join(root, "core.yaml");
  const fixturesFile = path.join(root, "fixtures.yaml");
  const fixtureData = path.join(root, "example.txt");
  fs.writeFileSync(specFile, "id: core\n");
  fs.writeFileSync(fixturesFile, "files: { example: ./example.txt }\n");
  fs.writeFileSync(fixtureData, "first fixture\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Receipt test", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: {
      specs: specFile,
      fixtures: fixturesFile,
      runs: path.join(root, "runs"),
      auth: path.join(root, "auth"),
    },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "",
    sourceFile: specFile,
    scenarios: [],
    rubric: [],
  };
  return { config, spec, fixtures: { files: { example: "./example.txt" } }, fixtureData };
}

test("browser receipts support headless-only installations and reject missing launch-mode binaries", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-shell-"));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  const expectedVersion = browser.version();
  await browser.close();
  let installation = path.dirname(chromium.executablePath());
  while (!/^chromium-\d+$/.test(path.basename(installation))) {
    const parent = path.dirname(installation);
    assert.notEqual(parent, installation, "Expected a Playwright-managed Chromium installation");
    installation = parent;
  }
  const cache = path.dirname(installation), shellOnly = path.join(root, "shell-only");
  fs.mkdirSync(shellOnly);
  for (const name of fs.readdirSync(cache).filter(name => /^(chromium_headless_shell|ffmpeg)-\d+$/.test(name))) {
    fs.symlinkSync(path.join(cache, name), path.join(shellOnly, name), "dir");
  }
  const { config, spec, fixtures } = inputs(root);
  config.target = { kind: "web", url: "http://127.0.0.1:4188", allowedOrigins: [] };
  spec.scenarios = [{ id: "SCENE", name: "Scene", instructions: "Capture", successSignals: [], dependsOn: [], requiresAuth: false, capture: captureSchema.parse({}) }];
  spec.rubric = [{ id: "CAPTURE", criterion: "Render", weight: 1, tags: [], scenarios: ["SCENE"], passCriteria: "Rendered", grader: { type: "capture" } }];
  process.env.PLAYWRIGHT_BROWSERS_PATH = shellOnly;
  const receipt = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(receipt.runtime.evidence?.chromium, expectedVersion);
  config.browser.headless = false;
  assert.throws(() => buildRunReceipt({ config, specs: [spec], fixtures }), /Unable to determine Chromium version for headed capture.*Executable doesn't exist/s);
  config.browser.headless = true;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, "empty-cache");
  assert.throws(() => buildRunReceipt({ config, specs: [spec], fixtures }), /Unable to determine Chromium version for headless capture.*Executable doesn't exist/s);
});

test("receipts only require Chromium for browser scenarios in the selected split and case selection", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-browser-selection-"));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, "empty-cache");
  const { config, spec, fixtures } = inputs(root);
  config.target.url = "http://127.0.0.1:4188";
  const common = { instructions: "Inspect", successSignals: [], dependsOn: [], requiresAuth: false };
  spec.scenarios = [
    { ...common, id: "BROWSER", name: "Browser", kind: "browser", capture: captureSchema.parse({}), cases: [{ id: "dev", variables: {}, strata: [], split: "development" }] },
    { ...common, id: "WORK", name: "Workspace", kind: "workspace", cases: [{ id: "eval", variables: {}, strata: [], split: "evaluation" }] },
  ];
  spec.rubric = [{ id: "CHECK", criterion: "Inspect", weight: 1, tags: [], scenarios: ["BROWSER", "WORK"], passCriteria: "Inspected", grader: { type: "llm" } }];
  const options = { config, specs: [spec], fixtures };
  assert.equal(buildRunReceipt({ ...options, split: "evaluation" }).runtime.evidence?.chromium, undefined);
  for (const selection of ["WORK", "WORK--eval"]) {
    assert.equal(buildRunReceipt({ ...options, scenarioIds: [selection] }).runtime.evidence?.chromium, undefined);
  }
  assert.throws(() => buildRunReceipt({ ...options, split: "development" }), /Unable to determine Chromium version for headless capture/);
  for (const selection of ["BROWSER", "BROWSER--dev"]) {
    assert.throws(() => buildRunReceipt({ ...options, scenarioIds: [selection] }), /Unable to determine Chromium version for headless capture/);
  }
  spec.scenarios[0].cases = undefined;
  spec.scenarios[0].split = "development";
  assert.equal(buildRunReceipt({ ...options, split: "evaluation" }).runtime.evidence?.chromium, undefined);
  assert.throws(() => buildRunReceipt({ ...options, split: "development" }), /Unable to determine Chromium version for headless capture/);
});

test("run receipts are deterministic and fingerprint exact fixture bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-"));
  const { config, spec, fixtures, fixtureData } = inputs(root);
  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  const repeated = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(repeated.evaluationFingerprint, first.evaluationFingerprint);
  assert.equal(repeated.inputFingerprint, first.inputFingerprint);
  assert.equal(first.inputs.fixtures?.files.example.bytes, Buffer.byteLength("first fixture\n"));

  fs.writeFileSync(fixtureData, "different fixture\n");
  const changed = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changed.evaluationFingerprint, first.evaluationFingerprint);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
});

test("prototype-named fixtures remain in receipts and affect fingerprints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-prototype-fixture-"));
  const { config, spec } = inputs(root);
  const fixtureData = path.join(root, "prototype.txt");
  fs.writeFileSync(config.paths.fixtures!, 'files:\n  "__proto__": ./prototype.txt\n');
  fs.writeFileSync(fixtureData, "first\n");
  const fixtures = JSON.parse('{"files":{"__proto__":"./prototype.txt"}}');

  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(Object.hasOwn(first.inputs.fixtures?.files ?? {}, "__proto__"), true);
  // biome-ignore lint/suspicious/noProto: Verify an own property named __proto__ survives serialization.
  assert.equal(first.inputs.fixtures?.files.__proto__.bytes, Buffer.byteLength("first\n"));
  fs.writeFileSync(fixtureData, "changed\n");
  const changed = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changed.evaluationFingerprint, first.evaluationFingerprint);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
  fs.rmSync(root, { recursive: true, force: true });
});

test("run receipts require a detectable provider CLI version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-version-"));
  const { config, spec, fixtures } = inputs(root);
  config.agent = { ...config.agent, provider: "codex" };
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(
      () => buildRunReceipt({ config, specs: [spec], fixtures }),
      /Unable to determine codex CLI version/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("target location changes remain comparable while additional origin policies do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-target-"));
  const { config, spec, fixtures } = inputs(root);
  spec.scenarios = [{
    id: "BROWSER",
    name: "Browser",
    kind: "browser",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  }];
  const baseline: EvalConfig = {
    ...config,
    target: {
      kind: "web",
      url: "https://baseline.example.test/app",
      allowedOrigins: ["https://baseline.example.test"],
    },
  };
  const first = buildRunReceipt({ config: baseline, specs: [spec], fixtures });
  const moved: EvalConfig = {
    ...baseline,
    target: {
      ...baseline.target,
      url: "https://candidate.example.test/app",
      allowedOrigins: ["https://candidate.example.test"],
    },
  };
  const changed = buildRunReceipt({ config: moved, specs: [spec], fixtures });
  assert.equal(changed.evaluationFingerprint, first.evaluationFingerprint);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);

  const expandedPolicy: EvalConfig = {
    ...moved,
    target: {
      ...moved.target,
      allowedOrigins: [
        "https://auth.example.test/",
        "https://candidate.example.test",
        "https://AUTH.example.test:443",
      ],
    },
  };
  const expanded = buildRunReceipt({ config: expandedPolicy, specs: [spec], fixtures });
  assert.notEqual(expanded.evaluationFingerprint, changed.evaluationFingerprint);

  const reorderedPolicy: EvalConfig = {
    ...expandedPolicy,
    target: {
      ...expandedPolicy.target,
      allowedOrigins: ["https://auth.example.test", "https://candidate.example.test"],
    },
  };
  const reordered = buildRunReceipt({ config: reorderedPolicy, specs: [spec], fixtures });
  assert.equal(reordered.evaluationFingerprint, expanded.evaluationFingerprint);
});

test("lifecycle policy participates in compatibility without binding project-local deployment paths", () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-lifecycle-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-lifecycle-second-"));
  const firstInputs = inputs(firstRoot);
  const secondInputs = inputs(secondRoot);
  firstInputs.config.target = {
    kind: "web",
    url: "https://baseline.example.test/app",
    allowedOrigins: ["https://baseline.example.test"],
    setup: {
      command: "pnpm install --frozen-lockfile",
      cwd: path.join(firstRoot, "packages", "app"),
      env: { NODE_ENV: "test" },
      timeoutSeconds: 300,
    },
    start: {
      command: "pnpm start",
      cwd: firstRoot,
      env: { PORT: "4173" },
      timeoutSeconds: 60,
    },
    ready: {
      url: "https://baseline.example.test/health?deep=1",
      timeoutSeconds: 120,
      intervalMs: 500,
    },
  };
  secondInputs.config.target = {
    ...firstInputs.config.target,
    url: "https://candidate.example.test/app",
    allowedOrigins: ["https://candidate.example.test"],
    setup: {
      ...firstInputs.config.target.setup!,
      cwd: path.join(secondRoot, "packages", "app"),
    },
    start: {
      ...firstInputs.config.target.start!,
      cwd: secondRoot,
    },
    ready: {
      ...firstInputs.config.target.ready!,
      url: "https://candidate.example.test/health?deep=1",
    },
  };

  try {
    const first = buildRunReceipt({
      config: firstInputs.config,
      specs: [firstInputs.spec],
      fixtures: firstInputs.fixtures,
    });
    const relocated = buildRunReceipt({
      config: secondInputs.config,
      specs: [secondInputs.spec],
      fixtures: secondInputs.fixtures,
    });
    assert.equal(relocated.evaluationFingerprint, first.evaluationFingerprint);

    const changedSetup = buildRunReceipt({
      config: {
        ...secondInputs.config,
        target: {
          ...secondInputs.config.target,
          setup: { ...secondInputs.config.target.setup!, command: "pnpm install" },
        },
      },
      specs: [secondInputs.spec],
      fixtures: secondInputs.fixtures,
    });
    assert.notEqual(changedSetup.evaluationFingerprint, first.evaluationFingerprint);

    const changedEnvironment = buildRunReceipt({
      config: {
        ...secondInputs.config,
        target: {
          ...secondInputs.config.target,
          start: { ...secondInputs.config.target.start!, env: { PORT: "5173" } },
        },
      },
      specs: [secondInputs.spec],
      fixtures: secondInputs.fixtures,
    });
    assert.notEqual(changedEnvironment.evaluationFingerprint, first.evaluationFingerprint);

    const changedReadiness = buildRunReceipt({
      config: {
        ...secondInputs.config,
        target: {
          ...secondInputs.config.target,
          ready: { ...secondInputs.config.target.ready!, intervalMs: 1_000 },
        },
      },
      specs: [secondInputs.spec],
      fixtures: secondInputs.fixtures,
    });
    assert.notEqual(changedReadiness.evaluationFingerprint, first.evaluationFingerprint);
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("workspace-only web evaluations ignore unused browser origin policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-workspace-web-"));
  const { config, spec, fixtures } = inputs(root);
  config.target = {
    kind: "web",
    url: "https://app.example.test",
    allowedOrigins: ["https://app.example.test", "https://auth.example.test"],
  };
  spec.scenarios = [{
    id: "WORKSPACE",
    name: "Workspace",
    kind: "workspace",
    instructions: "Inspect source",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  }];
  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  const changed = buildRunReceipt({
    config: {
      ...config,
      target: { ...config.target, allowedOrigins: ["https://app.example.test", "https://cdn.example.test"] },
    },
    specs: [spec],
    fixtures,
  });
  assert.equal(changed.evaluationFingerprint, first.evaluationFingerprint);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
});

test("mixed-mode browser origin policies participate in evaluator compatibility", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-mixed-browser-"));
  const { config, spec, fixtures } = inputs(root);
  config.target = {
    kind: "repository",
    url: "https://app.example.test",
    allowedOrigins: ["https://app.example.test", "https://auth.example.test"],
  };
  spec.scenarios = [{
    id: "BROWSER",
    name: "Browser",
    kind: "browser",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  }];
  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  const changed = buildRunReceipt({
    config: {
      ...config,
      target: { ...config.target, allowedOrigins: ["https://app.example.test", "https://cdn.example.test"] },
    },
    specs: [spec],
    fixtures,
  });
  assert.notEqual(changed.evaluationFingerprint, first.evaluationFingerprint);
});

test("development and evaluation split selections have distinct evaluator fingerprints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-split-"));
  const { config, spec, fixtures } = inputs(root);
  const development = buildRunReceipt({ config, specs: [spec], fixtures, split: "development" });
  const evaluation = buildRunReceipt({ config, specs: [spec], fixtures, split: "evaluation" });
  assert.equal(development.inputs.selection.split, "development");
  assert.notEqual(development.evaluationFingerprint, evaluation.evaluationFingerprint);
});

test("dirty Git contents affect resume fingerprints while AEK-owned artifacts do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-git-"));
  const { config, spec, fixtures } = inputs(root);
  fs.writeFileSync(path.join(root, "app.txt"), "version one\n");
  for (const args of [
    ["init"],
    ["config", "user.email", "aek@example.test"],
    ["config", "user.name", "AEK Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const clean = buildRunReceipt({ config, specs: [spec], fixtures });
  fs.mkdirSync(config.paths.runs, { recursive: true });
  fs.writeFileSync(path.join(config.paths.runs, "generated.json"), "{}\n");
  const withAekOutput = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(withAekOutput.inputFingerprint, clean.inputFingerprint);

  fs.writeFileSync(path.join(root, "app.txt"), "version two\n");
  const changed = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changed.inputFingerprint, clean.inputFingerprint);
  assert.equal(changed.target.git?.dirty, true);
  assert.match(changed.target.git?.worktreeSha256 ?? "", /^[a-f0-9]{64}$/);

  fs.chmodSync(path.join(root, "app.txt"), 0o755);
  const executable = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(executable.target.git?.worktreeSha256, changed.target.git?.worktreeSha256);
  assert.notEqual(executable.inputFingerprint, changed.inputFingerprint);
});

test("ignored Git runtime inputs affect resume fingerprints while dependency caches do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-git-ignored-"));
  const { config, spec, fixtures } = inputs(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\nnode_modules/\n");
  fs.writeFileSync(path.join(root, ".env"), "RUNTIME_VARIANT=one\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "derived.js"), "version one\n");
  for (const args of [
    ["init"],
    ["config", "user.email", "aek@example.test"],
    ["config", "user.name", "AEK Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  fs.writeFileSync(path.join(root, "node_modules", "derived.js"), "version two\n");
  const dependencyChanged = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(dependencyChanged.inputFingerprint, first.inputFingerprint);

  fs.writeFileSync(path.join(root, ".env"), "RUNTIME_VARIANT=two\n");
  const runtimeChanged = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(runtimeChanged.inputFingerprint, first.inputFingerprint);
  assert.equal(runtimeChanged.target.git?.dirty, true);
  assert.match(runtimeChanged.target.git?.worktreeSha256 ?? "", /^[a-f0-9]{64}$/);
});

test("unborn Git repositories fingerprint their untracked target contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-unborn-"));
  const { config, spec, fixtures } = inputs(root);
  const initialized = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(root, "app.txt"), "version one\n");
  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(first.target.git?.commit, "UNBORN");
  assert.equal(first.target.git?.dirty, true);
  assert.match(first.target.git?.worktreeSha256 ?? "", /^[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(root, "app.txt"), "version two\n");
  const changed = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
});

test("non-Git projects fingerprint target contents while excluding managed outputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-nongit-"));
  const { config, spec, fixtures } = inputs(root);
  const application = path.join(root, "app.txt");
  fs.writeFileSync(application, "version one\n");
  const first = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(first.target.git, undefined);
  assert.match(first.target.treeSha256 ?? "", /^[a-f0-9]{64}$/);

  fs.mkdirSync(config.paths.runs, { recursive: true });
  fs.writeFileSync(path.join(config.paths.runs, "generated.json"), "{}\n");
  const withManagedOutput = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.equal(withManagedOutput.inputFingerprint, first.inputFingerprint);

  fs.writeFileSync(application, "version two\n");
  const changed = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changed.target.treeSha256, first.target.treeSha256);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);

  fs.chmodSync(application, 0o755);
  const executable = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(executable.target.treeSha256, changed.target.treeSha256);
  assert.notEqual(executable.inputFingerprint, changed.inputFingerprint);
});

test("dirty submodule revisions and contents affect target fingerprints", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-submodule-"));
  const dependency = path.join(directory, "dependency");
  const root = path.join(directory, "project");
  fs.mkdirSync(dependency);
  fs.mkdirSync(root);
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const repository of [dependency, root]) {
    git(repository, ["init"]);
    git(repository, ["config", "user.email", "aek@example.test"]);
    git(repository, ["config", "user.name", "AEK Test"]);
  }
  fs.writeFileSync(path.join(dependency, "library.txt"), "version one\n");
  git(dependency, ["add", "."]);
  git(dependency, ["commit", "-m", "dependency one"]);
  const { config, spec, fixtures } = inputs(root);
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", dependency, "modules/dependency"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "project"]);

  const clean = buildRunReceipt({ config, specs: [spec], fixtures });
  const checkout = path.join(root, "modules", "dependency");
  git(checkout, ["config", "user.email", "aek@example.test"]);
  git(checkout, ["config", "user.name", "AEK Test"]);
  fs.writeFileSync(path.join(checkout, "library.txt"), "version two\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "dependency two"]);
  const changedRevision = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(changedRevision.inputFingerprint, clean.inputFingerprint);

  fs.writeFileSync(path.join(checkout, "library.txt"), "uncommitted dependency contents\n");
  const dirtyContents = buildRunReceipt({ config, specs: [spec], fixtures });
  assert.notEqual(dirtyContents.inputFingerprint, changedRevision.inputFingerprint);
});
