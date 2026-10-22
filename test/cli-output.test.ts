import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import YAML from "yaml";

const kit = path.resolve(import.meta.dirname, "..");
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-cli-output-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(kit, "examples/first-run"), root, { recursive: true });
  return root;
}
function invoke(root: string, args: string[], expected = 0) {
  const processResult = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), path.join(kit, "src/cli.ts"), ...args, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(processResult.status, expected, processResult.stdout + processResult.stderr);
  const envelope = JSON.parse(processResult.stdout);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.exitCode, expected);
  return { ...processResult, envelope, result: envelope.result };
}

test("execution JSON supports automation through resume, collection, judging and audited report updates", (t) => {
  const root = fixture(t);
  assert.equal(invoke(root, ["validate"]).result.configurationValid, true);
  assert.equal(invoke(root, ["list"]).result.areas[0].id, "cart");
  assert.ok(invoke(root, ["doctor"]).result.checks.length);
  const run = invoke(root, ["run"]);
  assert.equal(run.envelope.status, "completed");
  assert.equal(run.result.scorePct, 100);
  assert.equal(run.result.coveragePct, 80);
  assert.equal(run.result.manualPending, 1);
  assert.match(run.stderr, /Starting First evaluation/);
  const runDir = run.result.runDir;
  assert.equal(invoke(root, ["run", "--resume", runDir]).result.runId, run.result.runId);
  const initialHtml = fs.readFileSync(run.result.artifacts.html, "utf8");
  const spec = YAML.parse(fs.readFileSync(path.join(root, "specs/cart.yaml"), "utf8"));
  assert.ok(initialHtml.includes(spec.rubric[0].criterion));
  assert.match(initialHtml, /href="areas\/cart\/graders\/QUANTITY.stdout.txt"/);
  assert.match(initialHtml, /Expected 1000 cents; received 1000 cents/);
  assert.match(initialHtml, /data-result="pending"/);
  assert.ok(initialHtml.indexOf('class="headline"') < initialHtml.indexOf("Requested model"));

  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({
      RECEIPT: { verdict: "pass", notes: "Reviewed the example receipt instructions." },
    }),
  );
  const finalized = invoke(root, ["finalize", "--run", runDir, "--reviewer", "test-reviewer"]);
  assert.equal(finalized.result.coveragePct, 100);
  assert.equal(finalized.result.manualPending, 0);
  const finalHtml = fs.readFileSync(finalized.result.artifacts.html, "utf8");
  assert.match(finalHtml, /href="areas\/cart\/graders\/QUANTITY.stdout.txt"/);
  assert.match(finalHtml, /Expected 1000 cents; received 1000 cents/);
  assert.doesNotMatch(finalHtml, /aek-report-update-stage|artifact unavailable/);
  assert.ok(invoke(root, ["verify", "--run", runDir]).result.verifiedArtifacts > 0);

  const collected = invoke(root, ["collect"]);
  assert.equal(collected.result.mode, "collect");
  assert.equal(collected.result.scorePct, undefined);
  assert.ok(fs.existsSync(collected.result.artifacts.collection));
  const judged = invoke(root, ["judge", "--evidence", collected.result.runDir]);
  assert.equal(judged.result.scorePct, 100);
  assert.equal(judged.result.coveragePct, 80);
  assert.equal(invoke(root, ["rescore", "--run", judged.result.runDir]).result.scorePct, 100);
  const compared = invoke(root, [
    "compare",
    "--baseline",
    judged.result.runDir,
    "--candidate",
    judged.result.runDir,
    "--output",
    path.join(root, "comparison"),
  ]);
  assert.equal(compared.result.comparison.overall.scorePct.delta, 0);
  assert.ok(fs.existsSync(compared.result.artifacts.html));
});

test("JSON keeps withheld scores, acceptance failures and execution errors distinct", (t) => {
  const root = fixture(t);
  const configFile = path.join(root, "evalkit.yaml");
  const original = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(configFile, original.replace("minimumCoverage: 60", "minimumCoverage: 90"));
  const withheld = invoke(root, ["run"]);
  assert.equal(withheld.envelope.status, "completed");
  assert.equal(withheld.result.scorePct, null);
  assert.equal(withheld.result.provisionalScorePct, 100);
  assert.equal(withheld.result.scoreWithheld, true);
  fs.writeFileSync(configFile, original);
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  const failed = invoke(root, ["run"], 2);
  assert.equal(failed.envelope.status, "acceptance_failed");
  assert.equal(failed.result.execution, "complete");
  assert.equal(failed.result.scorePct, 25);
  assert.equal(failed.result.coveragePct, 80);
  assert.ok(failed.result.acceptanceFailures.length);
  const compared = invoke(
    root,
    [
      "compare",
      "--baseline",
      withheld.result.runDir,
      "--candidate",
      failed.result.runDir,
      "--output",
      path.join(root, "incompatible"),
    ],
    2,
  );
  assert.equal(compared.envelope.status, "acceptance_failed");
  assert.equal(compared.result.comparison.overall.scorePct.delta, null);

  fs.writeFileSync(
    path.join(root, "check.mjs"),
    'throw new Error("Checker cannot access its test fixture");\n',
  );
  const broken = invoke(root, ["run"], 1);
  assert.equal(broken.envelope.status, "error");
  assert.equal(broken.result, null);
  assert.match(broken.envelope.error.message, /Checker cannot access its test fixture/);
  assert.match(broken.stderr, /Changes to checker code.*require a new run/);
  assert.doesNotMatch(broken.stderr, /at main .*cli.ts/);
  assert.ok(fs.existsSync(broken.envelope.context.runDir));
  const invalid = invoke(root, ["validate", "--config", "missing.yaml"], 1);
  assert.doesNotMatch(invalid.stderr, /at readConfig/);
  const debug = invoke(root, ["validate", "--config", "missing.yaml", "--debug"], 1);
  assert.match(debug.stderr, /at readConfig/);
  fs.writeFileSync(configFile, original.replace("minimumCoverage: 60", "minimumCoverage: wrong"));
  assert.match(
    invoke(root, ["validate"], 1).envelope.error.message,
    /evalkit.yaml:\d+:\d+ scoring.minimumCoverage/,
  );
});

test("campaign execution and recovery emit a single structured result", (t) => {
  const root = fixture(t);
  const campaignDir = path.join(root, ".agent-eval/campaign");
  const first = invoke(root, ["campaign", "--repetitions", "2", "--output", campaignDir]);
  assert.equal(first.result.campaign.coverage.completedRuns, 2);
  const resumed = invoke(root, ["campaign", "--resume", campaignDir]);
  assert.equal(resumed.result.campaign.coverage.completedRuns, 2);
  assert.equal(resumed.result.campaign.runs.length, 2);
  const compared = invoke(root, [
    "campaign",
    "compare",
    "--baseline",
    campaignDir,
    "--candidate",
    campaignDir,
    "--output",
    path.join(root, ".agent-eval/campaign-comparison"),
  ]);
  assert.equal(compared.envelope.command, "campaign compare");
  assert.deepEqual(compared.result.acceptanceFailures, []);
});
