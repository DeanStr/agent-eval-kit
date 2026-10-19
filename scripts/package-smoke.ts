import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnCaptured } from "../src/providers/process.js";

const kitRoot = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-package-smoke-"));
let ordinal = 0;
async function run(
  command: string,
  args: string[],
  cwd: string,
  expectedExit = 0,
): Promise<string> {
  const id = ++ordinal;
  const result = await spawnCaptured({
    command,
    args,
    cwd,
    timeoutSeconds: 180,
    stdoutFile: path.join(scratch, `${id}.stdout.log`),
    stderrFile: path.join(scratch, `${id}.stderr.log`),
  });
  assert.equal(result.timedOut, false, `Timed out: ${command}`);
  assert.equal(
    result.exitCode,
    expectedExit,
    `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

try {
  await run(
    process.execPath,
    [path.join(kitRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    kitRoot,
  );
  const packed = JSON.parse(
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      kitRoot,
    ),
  );
  const archive = path.join(scratch, packed[0].filename);
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "aek-package-consumer", private: true }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", archive],
    consumer,
  );
  const installed = path.join(consumer, "node_modules/agent-eval-kit");
  for (const file of [
    "run.mjs",
    "docker-runner.mjs",
    "collect.mjs",
    "check.mjs",
    "spec.yaml",
    "controls.example.json",
    "README.md",
    "fixture/TASK.md",
    "fixture/cart.mjs",
    "fixture/cart.test.mjs",
    "variants/plain.md",
    "variants/reviewed.md",
  ])
    assert.ok(fs.statSync(path.join(installed, "examples/skill-comparison", file)).isFile(), file);
  assert.equal(
    fs.existsSync(path.join(installed, "src")),
    false,
    "package should run without source files",
  );
  assert.equal(
    fs.existsSync(path.join(consumer, "node_modules/tsx")),
    false,
    "consumer should not need tsx",
  );
  const cli = path.join(consumer, "node_modules/.bin/aek");
  assert.match(await run(cli, ["--help"], consumer), /Agent Eval Kit/);
  // Follow the installed first-run guide with a disposable target outside the
  // consumer, retaining the installed command's working directory throughout.
  const firstExample = path.join(scratch, "first-run-example");
  fs.cpSync(path.join(installed, "examples", "first-run"), firstExample, { recursive: true });
  assert.ok(fs.existsSync(path.join(installed, "docs", "first-run.md")));
  assert.ok(fs.existsSync(path.join(installed, "docs", "deployment.md")));
  const firstConfig = path.join(firstExample, "evalkit.yaml");
  const firstCli = (args: string[], expectedExit = 0) =>
    run("npx", ["--no-install", "aek", ...args], consumer, expectedExit);
  await firstCli(["validate", "--config", firstConfig]);
  const firstRuns = path.join(firstExample, ".agent-eval", "runs");
  const firstEvaluate = async (expectedExit: number, score: number, gate: boolean) => {
    const previous = fs.existsSync(firstRuns) ? fs.readdirSync(firstRuns) : [];
    await firstCli(["run", "--config", firstConfig], expectedExit);
    const added = fs.readdirSync(firstRuns).filter((id) => !previous.includes(id));
    assert.equal(added.length, 1);
    const directory = path.join(firstRuns, added[0]!);
    const report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
    assert.equal(report.overallScorePct, score);
    assert.equal(report.overallCoveragePct, 80);
    assert.equal(report.scoreWithheld, false);
    assert.equal(report.manualPending, 1);
    assert.equal(report.gates.passed, gate);
    assert.ok(fs.existsSync(path.join(directory, "report.html")));
    await firstCli(["verify", "--run", directory]);
    return directory;
  };
  const firstBaseline = await firstEvaluate(0, 100, true);
  fs.writeFileSync(
    path.join(firstExample, "cart.mjs"),
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  const firstCandidate = await firstEvaluate(2, 25, false);
  const firstComparison = path.join(scratch, "first-run-comparison");
  await firstCli(
    [
      "compare",
      "--baseline",
      firstBaseline,
      "--candidate",
      firstCandidate,
      "--fail-on-regression",
      "--output",
      firstComparison,
    ],
    2,
  );
  const firstDelta = JSON.parse(
    fs.readFileSync(path.join(firstComparison, "comparison.json"), "utf8"),
  );
  assert.equal(firstDelta.compatibility.status, "compatible");
  assert.equal(firstDelta.overall.scorePct.delta, -75);
  assert.equal(firstDelta.overall.coveragePct.delta, 0);
  assert.ok(fs.existsSync(path.join(firstComparison, "comparison.html")));

  const imageFile = path.join(consumer, "image.svg");
  fs.writeFileSync(
    imageFile,
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#3274ab"/></svg>',
  );
  const imageArgs = [
    "image",
    "compare",
    "--candidate",
    imageFile,
    "--reference",
    imageFile,
    "--criterion",
    "Clear shape and contrast",
    "--judge",
    "mock",
    "--minimum-votes",
    "1",
    "--maximum-votes",
    "1",
  ];
  const imagePlan = JSON.parse(await run(cli, [...imageArgs, "--dry-run", "--json"], consumer));
  assert.equal(imagePlan.candidate.width, 80);
  const imageOutput = path.join(consumer, "image-review");
  await run(cli, [...imageArgs, "--output", imageOutput], consumer, 2);
  const imageRuns = path.join(imageOutput, ".agent-eval", "runs");
  const imageRun = path.join(imageRuns, fs.readdirSync(imageRuns)[0]!);
  const imageReport = JSON.parse(fs.readFileSync(path.join(imageRun, "report.json"), "utf8"));
  assert.equal(imageReport.overallCoveragePct, 0);
  assert.equal(imageReport.gates.passed, false);
  await run(cli, ["verify", "--run", imageRun], consumer);
  assert.equal(fs.existsSync(path.join(installed, "docs", "image-comparison.md")), true);
  assert.equal(fs.existsSync(path.join(installed, "docs", "configuration.md")), true);
  const campaignHelp = await run(cli, ["campaign", "compare", "--help"], consumer);
  assert.match(campaignHelp, /--fail-on-regression/);
  assert.doesNotMatch(campaignHelp, /--resume/);
  const skillDirectory = path.join(consumer, ".agents", "skills");
  // The authoring workflow must work entirely from the installed package.
  await run(cli, ["author", "install", "--directory", skillDirectory], consumer);
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "references", "plan.md")));
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "references", "maintenance.md")));
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "templates", "review-note.md")));
  assert.ok(
    fs.existsSync(path.join(skillDirectory, "aek-author", "references", "docs", "authoring.md")),
  );
  await run(cli, ["author", "install", "--directory", skillDirectory], consumer, 1);
  const authorExample = path.join(consumer, "author-example");
  fs.cpSync(path.join(installed, "examples", "authoring"), authorExample, { recursive: true });
  const executionPlan = JSON.parse(
    await run(cli, ["campaign", "--repetitions", "2", "--dry-run", "--json"], authorExample),
  );
  assert.equal(executionPlan.version, 2);
  assert.equal(executionPlan.mode, "campaign");
  assert.equal(executionPlan.repetitions, 2);
  assert.ok(
    executionPlan.areas.some((area: { graders: Array<{ type: string }> }) =>
      area.graders.some((grader) => grader.type === "command"),
    ),
  );
  assert.equal(fs.existsSync(path.join(authorExample, ".agent-eval")), false);
  await run(cli, ["author", "init"], authorExample);
  await run(cli, ["author", "validate", "--require-ready"], authorExample, 2);
  const authorPlanFile = path.join(authorExample, ".aek-authoring", "plan.json");
  fs.copyFileSync(path.join(authorExample, "plan.json"), authorPlanFile);
  await run(cli, ["author", "validate", "--require-ready"], authorExample);
  await run(cli, ["run"], authorExample);
  const authorRuns = path.join(authorExample, ".agent-eval", "runs");
  const goodAuthorRun = fs.readdirSync(authorRuns)[0]!;
  const authorTarget = path.join(authorExample, "cart.mjs");
  const originalAuthorTarget = fs.readFileSync(authorTarget);
  fs.writeFileSync(
    authorTarget,
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  await run(cli, ["run"], authorExample, 2);
  const badAuthorRun = fs.readdirSync(authorRuns).find((id) => id !== goodAuthorRun)!;
  fs.writeFileSync(authorTarget, originalAuthorTarget);
  const authorPlan = JSON.parse(fs.readFileSync(authorPlanFile, "utf8"));
  for (const requirement of authorPlan.requirements)
    requirement.trials = [
      { kind: "good", run: `.agent-eval/runs/${goodAuthorRun}`, rationale: "Known good fixture" },
      {
        kind: "defect",
        run: `.agent-eval/runs/${badAuthorRun}`,
        rationale: "Quantity deliberately ignored",
      },
    ];
  fs.writeFileSync(authorPlanFile, JSON.stringify(authorPlan));
  const authorStatus = JSON.parse(await run(cli, ["author", "status", "--json"], authorExample));
  assert.deepEqual(
    authorStatus.requirements.map((entry: { stage: string }) => entry.stage),
    ["calibrated", "exercised"],
  );
  // Exercise text datasets and suite/selection/reference commands from the tarball.
  const textExample = path.join(consumer, "text-example");
  fs.cpSync(path.join(installed, "examples/text-datasets"), textExample, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".agent-eval",
  });
  await run(cli, ["validate", "--suite", "policy"], textExample);
  await run(cli, ["run", "--suite", "policy"], textExample, 2);
  const textRuns = path.join(textExample, ".agent-eval/runs");
  const textRun = path.join(textRuns, fs.readdirSync(textRuns)[0]!);
  await run(cli, ["verify", "--run", textRun], textExample);
  await run(cli, ["run", "--resume", textRun], textExample, 2);
  await run(
    cli,
    [
      "reference",
      "promote",
      "--suite",
      "policy",
      "--run",
      textRun,
      "--name",
      "fixture",
      "--reviewer",
      "package-smoke",
    ],
    textExample,
  );
  await run(cli, ["reference", "list", "--suite", "policy"], textExample);
  await run(cli, ["run", "--suite", "policy", "--changed-since", textRun], textExample, 2);
  // Exercise file collection and the public parser from a production-only install.
  const fileExample = path.join(consumer, "file-example");
  fs.cpSync(path.join(kitRoot, "examples/files"), fileExample, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".agent-eval",
  });
  await run(cli, ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"], fileExample);
  fs.writeFileSync(path.join(fileExample, "records.json"), JSON.stringify([{ id: "wrong" }]));
  await run(cli, ["run", "--fail-under-score", "100"], fileExample, 2);
  // Exercise the installed email export and the actual example collectors with
  // an isolated HTTP mailbox fixture, without contacting a real mail provider.
  const emailExample = path.join(consumer, "email-example");
  fs.cpSync(path.join(kitRoot, "examples/email"), emailExample, { recursive: true });
  const emailMessages: Array<Record<string, unknown>> = [];
  let emailBody = "Hello Priya — DevFlow Conf 2027";
  const emailServer = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/send") {
      emailMessages.push({
        message_id: `message-${emailMessages.length + 1}`,
        inbox_id: "speaker@agentmail.to",
        from: "notifications@app.example.test",
        to: [url.searchParams.get("recipient")],
        subject: url.searchParams.get("subject"),
        created_at: new Date().toISOString(),
        labels: ["received"],
        html: `<p>${emailBody}</p>`,
      });
      response.end("{}");
    } else {
      assert.equal(request.headers.authorization, "Bearer package-mailbox-fixture-key");
      response.end(
        JSON.stringify(
          url.pathname.endsWith("/messages")
            ? { messages: emailMessages }
            : emailMessages.find((message) => url.pathname.endsWith(`/${message.message_id}`)),
        ),
      );
    }
  });
  await new Promise<void>((resolve) => emailServer.listen(0, "127.0.0.1", resolve));
  const emailAddress = emailServer.address();
  assert.ok(emailAddress && typeof emailAddress !== "string");
  const emailUrl = `http://127.0.0.1:${emailAddress.port}`;
  const oldMailboxKey = process.env.AEK_PACKAGE_MAIL_KEY;
  process.env.AEK_PACKAGE_MAIL_KEY = "package-mailbox-fixture-key";
  try {
    const mailbox = JSON.parse(fs.readFileSync(path.join(emailExample, "mailbox.json"), "utf8"));
    mailbox.baseUrl = `${emailUrl}/v0`;
    mailbox.apiKeyEnv = "AEK_PACKAGE_MAIL_KEY";
    fs.writeFileSync(path.join(emailExample, "mailbox.json"), JSON.stringify(mailbox));
    const emailConfig = YAML.parse(
      fs.readFileSync(path.join(emailExample, "evalkit.yaml"), "utf8"),
    );
    emailConfig.target.url = emailUrl;
    emailConfig.agent = { provider: "mock" };
    emailConfig.judge = { provider: "mock" };
    emailConfig.mailboxes.speaker = mailbox;
    fs.writeFileSync(path.join(emailExample, "evalkit.yaml"), YAML.stringify(emailConfig));
    const emailSpecPath = path.join(emailExample, "specs/email.yaml");
    const emailSpec = YAML.parse(fs.readFileSync(emailSpecPath, "utf8"));
    const send = emailSpec.scenarios.find(
      (scenario: { id: string }) => scenario.id === "SEND-MAIL",
    );
    send.kind = "command";
    delete send.persona;
    delete send.requiresAuth;
    send.collect = { command: "node send.mjs", methodFiles: ["send.mjs"] };
    fs.writeFileSync(emailSpecPath, YAML.stringify(emailSpec));
    fs.writeFileSync(
      path.join(emailExample, "send.mjs"),
      `
import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, 'utf8'));
const url = new URL('/send', ${JSON.stringify(emailUrl)});
url.searchParams.set('recipient', c.inputs.recipient.value);
url.searchParams.set('subject', c.inputs.subject.value);
const response = await fetch(url);
if (!response.ok) throw new Error('Fixture send failed');
console.log(JSON.stringify({ version: 1, outcome: 'completed', summary: 'Sent notification', observations: [] }));
`,
    );
    await run(
      cli,
      ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"],
      emailExample,
    );
    emailBody = "Incorrect notification body";
    await run(cli, ["run", "--fail-under-score", "100"], emailExample, 2);
  } finally {
    if (oldMailboxKey === undefined) delete process.env.AEK_PACKAGE_MAIL_KEY;
    else process.env.AEK_PACKAGE_MAIL_KEY = oldMailboxKey;
    await new Promise<void>((resolve) => {
      emailServer.close(() => resolve());
      emailServer.closeAllConnections();
    });
  }
  await run(cli, ["init"], consumer);
  const configFile = path.join(consumer, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.target = { kind: "repository" };
  config.agent = { provider: "mock" };
  config.judge = { provider: "mock" };
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(
    path.join(consumer, "evals/specs/core.yaml"),
    YAML.stringify({
      id: "core",
      title: "Installed package",
      description: "Production dependency smoke",
      weight: 100,
      scenarios: [{ id: "S1", name: "Inspect", instructions: "Inspect the project" }],
      rubric: [
        {
          id: "R1",
          criterion: "Installed CLI runs",
          weight: 1,
          gate: true,
          grader: {
            type: "command",
            methodFiles: [],
            output: "exit-code",
            command: 'node -e "process.exit(0)"',
          },
          passCriteria: "Exit zero",
        },
      ],
    }),
  );
  await run(cli, ["validate"], consumer);
  await run(cli, ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"], consumer);
  const runsRoot = path.join(consumer, ".agent-eval/runs");
  const runDir = path.join(
    runsRoot,
    requireDefined(fs.readdirSync(runsRoot)[0], "fs.readdirSync(runsRoot)[0]"),
  );
  await run(cli, ["verify", "--run", runDir], consumer);
  assert.ok(fs.existsSync(path.join(runDir, "report.html")));

  await run(cli, ["collect", "--split", "all"], consumer);
  const collectionDir = fs
    .readdirSync(runsRoot)
    .map((name) => path.join(runsRoot, name))
    .find((dir) => fs.existsSync(path.join(dir, "collection.json")))!;
  const collectionIndex = fs.readFileSync(path.join(collectionDir, "artifact-index.json"));
  await run(cli, ["judge", "--evidence", collectionDir, "--fail-under-score", "100"], consumer);
  const judgingDir = fs
    .readdirSync(runsRoot)
    .map((name) => path.join(runsRoot, name))
    .find((dir) => {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "run-state.json"), "utf8"));
      return state.mode === "judge";
    })!;
  await run(cli, ["verify", "--run", judgingDir], consumer);
  await run(
    cli,
    [
      "baseline",
      "promote",
      "--config",
      "evalkit.yaml",
      "--run",
      judgingDir,
      "--name",
      "main",
      "--reviewer",
      "package-smoke",
    ],
    consumer,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(collectionDir, "artifact-index.json")),
    collectionIndex,
  );

  // Launch the installed MCP entry point with production dependencies only.
  // Mock evaluations alone would never start an MCP subprocess.
  const evidence = path.join(scratch, "workspace-evidence");
  const contextFile = path.join(scratch, "workspace-context.json");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({ projectRoot: consumer, evidenceDir: evidence, requiredCheckpoints: [] }),
  );
  const client = new Client({ name: "aek-package-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installed, "dist/workspace/mcp.js"), contextFile],
    cwd: consumer,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "package.json" },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /aek-package-consumer/);
    await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Installed workspace MCP reads project files." },
    });
  } finally {
    await client.close();
    await transport.close();
  }
  const visualRoot = path.join(consumer, "visual");
  fs.mkdirSync(path.join(visualRoot, "specs"), { recursive: true });
  const example = path.join(kitRoot, "examples/visual");
  fs.copyFileSync(path.join(example, "reference.svg"), path.join(visualRoot, "reference.svg"));
  fs.copyFileSync(
    path.join(example, "specs/dashboard.yaml"),
    path.join(visualRoot, "specs/dashboard.yaml"),
  );
  const html = fs.readFileSync(path.join(example, "index.html"));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const visualConfig = YAML.parse(fs.readFileSync(path.join(example, "evalkit.yaml"), "utf8"));
    visualConfig.target = {
      kind: "web",
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    };
    fs.writeFileSync(path.join(visualRoot, "evalkit.yaml"), YAML.stringify(visualConfig));
    await run(cli, ["validate"], visualRoot);
    // Mock votes must withhold the visual gate despite passing capture checks.
    await run(cli, ["run"], visualRoot, 2);
    const visualRuns = path.join(visualRoot, ".agent-eval/runs");
    const visualRun = path.join(
      visualRuns,
      requireDefined(fs.readdirSync(visualRuns)[0], "fs.readdirSync(visualRuns)[0]"),
    );
    await run(cli, ["verify", "--run", visualRun], visualRoot);
    const report = JSON.parse(fs.readFileSync(path.join(visualRun, "report.json"), "utf8"));
    assert.equal(report.areas[0].items[0].verdict, "pass");
    assert.equal(report.areas[0].items[1].verdict, "cannot_judge");
    assert.equal(report.areas[0].items[1].votes.judgeable, 0);
    assert.equal(report.areas[0].items[2].source, "image-distinctness");
    assert.equal(report.areas[0].items[2].verdict, "pass");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(
    "Package smoke passed: tarball install, offline first-run scores/coverage/gates/comparison, direct two-image comparison, authoring skill/map/calibration, text datasets/suites/selection/reference promotion, file and email collector/checker pass and failure, executable bin, init, validate, run, collect, judge, release promotion, verify, installed MCP, and controlled visual capture/pairwise abstention without dev dependencies.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
