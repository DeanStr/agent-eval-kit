import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadResolvedConfig, redactConfig } from "../src/config.js";
import { assertCollectionCompatible, loadCollection, sealCollection } from "../src/collection.js";
import { assertScenarioTargetCompatibility, loadFixtures, loadSpecs } from "../src/specs.js";

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "aek-test-"));

test("spec normalization preserves tagged YAML case variables", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "spec.yaml");
  fs.writeFileSync(
    file,
    `id: core
title: Core
weight: 100
description: Contract
scenarios:
  - id: S1
    name: Inspect
    instructions: Inspect
    cases:
      - id: tagged
        variables:
          date: !!timestamp 2026-01-01
          binary: !!binary SGVsbG8=
rubric:
  - { id: R1, criterion: Works, weight: 1, passCriteria: Works }
`,
  );
  const spec = requireDefined(loadSpecs(file)[0], "loaded spec");
  const scenario = requireDefined(spec.scenarios[0], "loaded scenario");
  const scenarioCase = requireDefined(scenario.cases?.[0], "loaded case");
  assert.deepEqual(scenarioCase.variables.date, new Date("2026-01-01T00:00:00.000Z"));
  assert.deepEqual(scenarioCase.variables.binary, Buffer.from("Hello"));
});

test("command grader output mode is explicit and strictly validated", () => {
  const root = temporary();
  const file = path.join(root, "spec.yaml");
  for (const mode of ["", ", output: auto", ", output: json", ", output: exit-code"]) {
    fs.writeFileSync(
      file,
      `id: core\ntitle: Core\nweight: 100\ndescription: Contract\nscenarios:\n  - { id: S1, name: Inspect, instructions: Inspect }\nrubric:\n  - id: R1\n    criterion: Works\n    weight: 1\n    passCriteria: Works\n    grader: { type: command, methodFiles: [], command: test${mode} }\n`,
    );
    if (mode === "" || mode.endsWith("auto")) assert.throws(() => loadSpecs(file), /output/);
    else
      assert.equal(
        requireDefined(
          requireDefined(loadSpecs(file)[0], "loadSpecs(file)[0]").rubric[0],
          "loadSpecs(file)[0].rubric[0]",
        ).grader.type,
        "command",
      );
  }
});

test("config paths resolve from config and project root, with safe defaults", () => {
  const root = temporary();
  const nested = path.join(root, "config");
  fs.mkdirSync(nested);
  const file = path.join(nested, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: ../project }
target: { kind: repository }
paths: { specs: checks }
`,
  );
  const config = loadConfig(file);
  assert.equal(config.project.root, path.join(root, "project"));
  assert.equal(config.paths.specs, path.join(root, "project", "checks"));
  assert.equal(config.agent.provider, "codex");
  assert.equal(config.scoring.minimumCoverage, 60);
  assert.deepEqual(config.target.allowedOrigins, []);
});

test("config refuses a missing environment interpolation", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "\${AEK_TEST_MISSING}" }
`,
  );
  assert.throws(() => loadConfig(file), /missing environment variable AEK_TEST_MISSING/);
});

test("config rejects credential-bearing target and readiness URLs", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "https://app.example.test/?access_token=retained-secret" }
`,
  );
  assert.throws(
    () => loadConfig(file),
    /must not include credential-bearing query or fragment parameters/,
  );

  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://app.example.test/
  ready: { url: "https://status.example.test/health?signature=retained-secret" }
`,
  );
  assert.throws(
    () => loadConfig(file),
    /must not include credential-bearing query or fragment parameters/,
  );

  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "https://app.example.test/callback#access_token=retained-secret&token_type=bearer" }
`,
  );
  assert.throws(
    () => loadConfig(file),
    /must not include credential-bearing query or fragment parameters/,
  );

  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "https://app.example.test/callback#session:retained-secret" }
`,
  );
  assert.throws(
    () => loadConfig(file),
    /must not include credential-bearing query or fragment parameters/,
  );

  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "https://app.example.test/?tenant=public-demo#/dashboard?tab=activity" }
`,
  );
  assert.equal(
    loadConfig(file).target.url,
    "https://app.example.test/?tenant=public-demo#/dashboard?tab=activity",
  );
  assert.throws(
    () => loadConfig(file, { targetUrl: "https://preview.example.test/?key=retained-secret" }),
    /Invalid --url: must not include credential-bearing query or fragment parameters/,
  );
});

test("config loads adjacent .env values and accepts bounded-run overrides", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  const variable = `AEK_TEST_DOTENV_${process.pid}`;
  fs.writeFileSync(path.join(root, ".env"), `${variable}=https://configured.example.test\n`);
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: "${"${"}${variable}}" }
agent: { provider: mock }
`,
  );
  const configured = loadConfig(file);
  assert.equal(configured.target.url, "https://configured.example.test");
  const overridden = loadConfig(file, {
    targetUrl: "https://override.example.test/path",
    maxTurns: 7,
  });
  assert.equal(overridden.target.url, "https://override.example.test/path");
  assert.deepEqual(overridden.target.allowedOrigins, ["https://override.example.test"]);
  assert.equal(overridden.agent.maxTurns, 7);
  delete process.env[variable];
});

test("a URL override rebases target-bound readiness without changing an external probe", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://configured.example.test/app
  ready: { url: https://configured.example.test/health?deep=1 }
`,
  );
  const overridden = loadConfig(file, { targetUrl: "http://127.0.0.1:4173/preview" });
  assert.equal(overridden.target.ready?.url, "http://127.0.0.1:4173/health?deep=1");

  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://configured.example.test/app
  ready: { url: https://status.example.test/target-health }
`,
  );
  const external = loadConfig(file, { targetUrl: "https://preview.example.test/build" });
  assert.equal(external.target.ready?.url, "https://status.example.test/target-health");
});

test("config requires exactly one readiness probe", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://configured.example.test
  ready:
    url: https://configured.example.test/health
    command: node check-ready.js
`,
  );
  assert.throws(() => loadConfig(file), /ready needs exactly one of url or command/);
});

test("config rejects unknown keys instead of silently ignoring typos", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: repository }
scorng: { minimumCoverage: 80 }
`,
  );
  assert.throws(() => loadConfig(file), /Unrecognized key.*scorng/);
});

test("authenticated scenarios require a persona and browser execution", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "auth.yaml"),
    `id: auth
title: Auth
weight: 100
description: Auth validation
scenarios:
  - { id: NO_PERSONA, name: Missing persona, kind: browser, instructions: Inspect, requiresAuth: true }
  - { id: WORKSPACE_AUTH, name: Wrong mode, kind: workspace, persona: buyer, instructions: Inspect, requiresAuth: true }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [NO_PERSONA], grader: { type: llm }, passCriteria: Works }
`,
  );
  const specs = loadSpecs(root);
  assert.throws(
    () =>
      assertScenarioTargetCompatibility(specs, { kind: "web", url: "https://app.example.test" }),
    /NO_PERSONA requires authentication but has no persona[\s\S]*WORKSPACE_AUTH requires authentication but resolves to workspace mode/,
  );
});

test("every browser scenario requires a configured target URL", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "browser.yaml"),
    `id: browser
title: Browser
weight: 100
description: Browser validation
scenarios:
  - { id: PUBLIC_BROWSER, name: Public browser, kind: browser, instructions: Inspect }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [PUBLIC_BROWSER], grader: { type: llm }, passCriteria: Works }
`,
  );
  const specs = loadSpecs(root);
  assert.throws(
    () => assertScenarioTargetCompatibility(specs, { kind: "repository" }),
    /PUBLIC_BROWSER uses browser mode but target\.url is not configured/,
  );
});

test("config rejects viewports that would make screenshots unusable as judge evidence", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: https://app.example.test }
browser: { viewport: { width: 2560, height: 1440 } }
`,
  );
  assert.throws(() => loadConfig(file), /2000px evidence-image limit/);
});

test("web targets reject non-HTTP URLs and always retain their own origin", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://app.example.test/path
  allowedOrigins: [https://app.example.test, https://cdn.example.test, "https://*.assets.example.test"]
`,
  );
  const config = loadConfig(file);
  assert.deepEqual(config.target.allowedOrigins, [
    "https://app.example.test",
    "https://cdn.example.test",
    "https://*.assets.example.test",
  ]);
  const overridden = loadConfig(file, { targetUrl: "https://preview.example.test/build" });
  assert.deepEqual(overridden.target.allowedOrigins, [
    "https://preview.example.test",
    "https://cdn.example.test",
    "https://*.assets.example.test",
  ]);
  assert.throws(() => loadConfig(file, { targetUrl: "file:///tmp/fake.html" }), /Invalid --url/);
});

test("wildcard origins must remain valid URLs after wildcard substitution", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  for (const origin of ["https://*.bad host", "https://*.example.test:70000"]) {
    fs.writeFileSync(
      file,
      `version: 1
project: { name: Demo, root: . }
target:
  kind: web
  url: https://app.example.test
  allowedOrigins: [${JSON.stringify(origin)}]
`,
    );
    assert.throws(() => loadConfig(file), /must be an exact HTTP\(S\) origin or wildcard/);
  }
});

test("resolved config snapshots redact secrets embedded in command strings", () => {
  const root = temporary();
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    file,
    `version: 1
project: { name: Demo, root: . }
target:
  kind: command
  setup:
    command: >-
      deploy --token super-secret-value --api-key=sk-proj-abcdefghijklmnop
      --auth-token "quoted-auth-secret" --password='quoted-password-secret'
    env:
      DATABASE_URL: postgres://alice:database-password@db.internal/app
`,
  );
  const safe = JSON.stringify(redactConfig(loadConfig(file)));
  assert.doesNotMatch(
    safe,
    /super-secret-value|sk-proj-abcdefghijklmnop|quoted-auth-secret|quoted-password-secret|database-password/,
  );
  assert.match(safe, /\[REDACTED\]/);
  assert.match(safe, /postgres:\/\/alice:\[REDACTED\]@db\.internal\/app/);
});

test("email declarations preserve extraction rules while redacting expanded secret values", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "evalkit.yaml");
  fs.writeFileSync(path.join(root, ".env"), "AEK_EMAIL_REDACTION_TEST=fixture-selector-secret\n");
  const original = process.env.AEK_EMAIL_REDACTION_TEST;
  delete process.env.AEK_EMAIL_REDACTION_TEST;
  t.after(() => {
    if (original === undefined) delete process.env.AEK_EMAIL_REDACTION_TEST;
    else process.env.AEK_EMAIL_REDACTION_TEST = original;
  });
  const yaml = `version: 1
project: { name: Demo, root: . }
target: { kind: web, url: https://app.example.test }
mailboxes:
  session-user:
    provider: agentmail
    inboxId: test-inbox
    address: user@example.test
    apiKeyEnv: AGENTMAIL_API_KEY
emailAuth:
  session-user:
    mailbox: session-user
    startPath: /login
    emailSelector: 'input[data-token="\${AEK_EMAIL_REDACTION_TEST}"]'
    requestSelector: '#send'
    message: { from: login@example.test, subject: Sign in }
    credential: { type: link, path: /verify, parameter: token }
    success: { selector: '#identity', text: user@example.test }
`;
  fs.writeFileSync(file, yaml);
  const config = loadConfig(file);
  assert.match(config.emailAuth!["session-user"]!.emailSelector, /fixture-selector-secret/);
  const safe = redactConfig(config);
  assert.doesNotMatch(JSON.stringify(safe), /fixture-selector-secret/);
  assert.match(safe.emailAuth!["session-user"]!.emailSelector, /\[REDACTED\]/);
  assert.deepEqual(
    safe.emailAuth!["session-user"]!.credential,
    config.emailAuth!["session-user"]!.credential,
  );
  assert.deepEqual(safe.mailboxes, config.mailboxes);
  for (const selector of [
    'input[data-token="fixture-selector-secret"]',
    "input[data-token='fixture-selector-secret']",
    "input[data-token=fixture-selector-secret]",
  ]) {
    config.emailAuth!["session-user"]!.emailSelector = selector;
    const redacted = redactConfig(config);
    fs.writeFileSync(file, JSON.stringify(redacted));
    sealCollection(root, config, [], "all");
    const sealed = loadResolvedConfig(file);
    assertCollectionCompatible(loadCollection(root), sealed, [], false);
    assert.deepEqual(redactConfig(sealed), redacted);
    assert.doesNotMatch(JSON.stringify(sealed), /fixture-selector-secret/);
  }
  // The review's startPath example is already rejected before snapshotting.
  fs.writeFileSync(file, yaml.replace("startPath: /login", "startPath: /login?token=secret"));
  assert.throws(() => loadConfig(file), /credential-bearing/);
});

test("spec validation catches cross-reference and total-weight errors", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "bad.yaml"),
    `id: area
title: Area
weight: 90
description: Test
scenarios:
  - { id: S1, name: One, instructions: Do it }
rubric:
  - id: R1
    criterion: Works
    weight: 1
    scenarios: [MISSING]
    grader: { type: llm }
    passCriteria: It works
`,
  );
  assert.throws(() => loadSpecs(root), /references unknown scenario MISSING[\s\S]*sum to 100/);
});

test("scenario ids cannot collide with reserved run artifacts", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "reserved.yaml"),
    `id: area
title: Area
weight: 100
description: Reserved paths
scenarios:
  - { id: REPORT.JSON, name: Collision, instructions: Inspect }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [REPORT.JSON], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /scenario id REPORT\.JSON is reserved by the run artifact layout/,
  );
});

test("artifact-backed ids cannot differ only by case", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "one.yaml"),
    `id: Checkout
title: One
weight: 50
description: One
scenarios:
  - { id: Create, name: Create, instructions: Inspect }
rubric:
  - { id: VERIFY, criterion: Works, weight: 1, scenarios: [Create], grader: { type: llm }, passCriteria: Works }
`,
  );
  fs.writeFileSync(
    path.join(root, "two.yaml"),
    `id: checkout
title: Two
weight: 50
description: Two
scenarios:
  - { id: create, name: Create again, instructions: Inspect }
rubric:
  - { id: verify, criterion: Works too, weight: 1, scenarios: [create], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /area ids Checkout and checkout collide[\s\S]*scenario ids Create and create collide[\s\S]*rubric ids VERIFY and verify collide/,
  );
});

test("expanded scenario ids are collision-checked case-insensitively", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "expanded.yaml"),
    `id: area
title: Area
weight: 100
description: Expanded collision
scenarios:
  - { id: Flow--Case, name: Existing, instructions: Inspect }
  - id: flow
    name: Matrix
    instructions: Inspect
    cases:
      - { id: case }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [flow], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /expanded scenario id flow--case collides with another scenario or case across the spec set/,
  );
});

test("area and scenario artifact IDs are bounded before they become directory names", () => {
  const root = temporary();
  const longId = "s".repeat(101);
  fs.writeFileSync(
    path.join(root, "long-scenario.yaml"),
    `id: area
title: Area
weight: 100
description: Long scenario
scenarios:
  - { id: ${longId}, name: Long, instructions: Inspect }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(() => loadSpecs(root), /scenarios\.0\.id: must be at most 100 characters/);

  fs.rmSync(path.join(root, "long-scenario.yaml"));
  fs.writeFileSync(
    path.join(root, "long-case.yaml"),
    `id: area
title: Area
weight: 100
description: Long case
scenarios:
  - id: flow
    name: Matrix
    instructions: Inspect
    cases:
      - { id: ${longId} }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [flow], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /scenarios\.0\.cases\.0\.id: must be at most 100 characters/,
  );

  fs.rmSync(path.join(root, "long-case.yaml"));
  fs.writeFileSync(
    path.join(root, "long-area.yaml"),
    `id: ${longId}
title: Area
weight: 100
description: Long area
scenarios:
  - { id: flow, name: Flow, instructions: Inspect }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [flow], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(() => loadSpecs(root), /id: must be at most 100 characters/);
});

test("artifact-backed IDs reject Windows device names and terminal dots", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "nonportable.yaml"),
    `id: CON
title: Area
weight: 100
description: Non-portable IDs
scenarios:
  - id: AUX.txt
    name: Matrix
    instructions: Inspect
    cases:
      - { id: LPT1 }
rubric:
  - { id: NUL.log, criterion: Works, weight: 1, scenarios: [AUX.txt], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /id: must not be a Windows reserved device name[\s\S]*scenarios\.0\.id: must not be a Windows reserved device name[\s\S]*cases\.0\.id: must not be a Windows reserved device name[\s\S]*rubric\.0\.id: must not be a Windows reserved device name/,
  );

  fs.writeFileSync(
    path.join(root, "nonportable.yaml"),
    `id: area.
title: Area
weight: 100
description: Non-portable ID
scenarios:
  - { id: flow, name: Flow, instructions: Inspect }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [flow], grader: { type: llm }, passCriteria: Works }
`,
  );
  assert.throws(
    () => loadSpecs(root),
    /id: must not be a Windows reserved device name or end in a dot/,
  );
});

test("hybrid graders require manual instructions", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "bad.yaml"),
    `id: area
title: Area
weight: 100
description: Test
scenarios:
  - { id: S1, name: One, instructions: Do it }
rubric:
  - id: R1
    criterion: Works
    weight: 1
    scenarios: [S1]
    grader: { type: hybrid, autoShare: 0.25 }
    passCriteria: It works
`,
  );
  assert.throws(() => loadSpecs(root), /hybrid grader requires manualInstructions/);
});

test("scenario dependencies may refer to a later scenario", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "bad-order.yaml"),
    `id: area
title: Area
weight: 100
description: Test
scenarios:
  - { id: S1, name: One, instructions: Do it, dependsOn: [S2] }
  - { id: S2, name: Two, instructions: Do it }
rubric:
  - id: R1
    criterion: Works
    weight: 1
    scenarios: [S1]
    grader: { type: llm }
    passCriteria: It works
`,
  );
  assert.deepEqual(
    requireDefined(
      requireDefined(loadSpecs(root)[0], "loadSpecs(root)[0]").scenarios[0],
      "loadSpecs(root)[0].scenarios[0]",
    ).dependsOn,
    ["S2"],
  );
});

test("specs reject unknown fields instead of running with misspelled behavior", () => {
  const root = temporary();
  fs.writeFileSync(
    path.join(root, "typo.yaml"),
    `id: area
title: Area
weight: 100
description: Test
scenarios:
  - { id: S1, name: One, instructions: Do it, requireAuth: true }
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [S1], grader: { type: llm }, passCriteria: It works }
`,
  );
  assert.throws(() => loadSpecs(root), /requireAuth/);
});

test("fixture files are validated relative to the fixture document", () => {
  const root = temporary();
  fs.mkdirSync(path.join(root, "files"));
  fs.writeFileSync(path.join(root, "files", "avatar.png"), "image");
  const fixtureFile = path.join(root, "fixtures.yaml");
  fs.writeFileSync(fixtureFile, "data: { user: Demo }\nfiles: { avatar: ./files/avatar.png }\n");
  assert.deepEqual(loadFixtures(fixtureFile), {
    data: { user: "Demo" },
    files: { avatar: "./files/avatar.png" },
  });
});

test("fixture validation reports all missing, invalid, and non-file paths", () => {
  const root = temporary();
  fs.mkdirSync(path.join(root, "a-directory"));
  const fixtureFile = path.join(root, "fixtures.yaml");
  fs.writeFileSync(
    fixtureFile,
    "files:\n  missing: ./absent.csv\n  invalid: 42\n  directory: ./a-directory\n",
  );
  assert.throws(
    () => loadFixtures(fixtureFile),
    /files\.missing does not exist[\s\S]*files\.invalid must be a non-empty path string[\s\S]*files\.directory is not a regular file/,
  );
});

test("read-only preview configuration requires explicit selectors and pathname prefixes", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "evalkit.yaml");
  const write = (policy: object) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        project: { name: "Preview", root: "." },
        target: { kind: "web", url: "https://app.example.test" },
        browser: { readOnlyFrames: [policy] },
      }),
    );
  write({ selector: "iframe.preview", pathPrefix: "/compose/" });
  assert.deepEqual(loadConfig(file).browser.readOnlyFrames, [
    { selector: "iframe.preview", pathPrefix: "/compose/" },
  ]);
  for (const policy of [
    { selector: "", pathPrefix: "/compose/" },
    { selector: "iframe", pathPrefix: "https://external.test/" },
    { selector: "iframe", pathPrefix: "/compose" },
    { selector: "iframe", pathPrefix: "/compose/?x=1" },
  ]) {
    write(policy);
    assert.throws(() => loadConfig(file), /readOnlyFrames/);
  }
});
