import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { verifyArtifactIndex } from "../src/integrity.js";

const cli = path.resolve("src/cli.ts"),
  tsx = import.meta.resolve("tsx");
async function fixture(t: TestContext, decisions: Record<string, "equivalent" | "abstain"> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-image-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "image.png"),
    await sharp({ create: { width: 24, height: 16, channels: 3, background: "#389abc" } })
      .png()
      .toBuffer(),
  );
  fs.writeFileSync(
    path.join(root, "image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#389abc"/></svg>',
  );
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(root, "calls.ndjson");
  const fail = path.join(root, "fail"),
    capacity = path.join(root, "capacity"),
    versionFailure = path.join(root, "version-failure"),
    versionCalls = path.join(root, "version-calls.json");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args.includes('--version')){
 if(fs.existsSync(${JSON.stringify(versionFailure)})){
  const file=${JSON.stringify(versionCalls)},count=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8'))+1:1;
  fs.writeFileSync(file,JSON.stringify(count));
  if(count===3){console.error('Temporary version probe failure');process.exit(1)}
 }
 console.log('codex batch fixture 1');process.exit(0)
}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',async()=>{
 const key=/CRITERION: ([^\\n]+)/.exec(prompt)?.[1]??'quality';
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({key,event:'start',at:Date.now()})+'\\n');
 const count=fs.readFileSync(${JSON.stringify(calls)},'utf8').split('\\n').filter(l=>l&&JSON.parse(l).key===key&&JSON.parse(l).event==='start').length;
 if(key.includes('slow'))await new Promise(r=>setTimeout(r,600));
 if(key.includes('fail')&&fs.existsSync(${JSON.stringify(fail)})){console.error('Authentication failed');process.exit(19)}
 if(key.includes('capacity')&&count===2&&fs.existsSync(${JSON.stringify(capacity)})){console.log(JSON.stringify({type:'turn.failed',error:{message:'Model is at capacity'}}));process.exit(19)}
 const output=args[args.indexOf('--output-last-message')+1];
 const parts=path.relative(${JSON.stringify(root)},output).split(path.sep),id=parts[parts.indexOf('pairs')+1];
 const result={preferred:${JSON.stringify(decisions)}[id]??'equivalent',confidence:0.95,reasoning:'Offline fixture; this is not a real visual assessment.',findings:[]};
 const text=JSON.stringify(result);fs.writeFileSync(output,text);
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({key,event:'end',at:Date.now()})+'\\n');
});
`,
    { mode: 0o755 },
  );
  const manifest = path.join(root, "manifest.json");
  const row = (id: string, criterion = id) => ({
    id,
    label: `${id} <script>bad</script>`,
    candidate: "image.png",
    reference: "image.png",
    criterion,
  });
  function write(comparisons: ReturnType<typeof row>[], extra = {}) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        defaults: {
          judge: "codex",
          judgeModel: "gpt-6.1-sol",
          judgeEffort: "high",
          voting: { minimumVotes: 2, maximumVotes: 2, agreement: 1 },
          panel: { width: 64, height: 64 },
          ...extra,
        },
        comparisons,
      }),
    );
  }
  function run(args: string[], expected = 0, cwd = root) {
    const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
      cwd,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result;
  }
  const events = () =>
    fs.existsSync(calls)
      ? fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { key: string; event: string; at: number })
      : [];
  const summary = (output: string) =>
    JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
  return { root, manifest, fail, capacity, versionFailure, row, write, run, events, summary };
}

test("batch preflights all rows, validates CLI contracts, and previews without output or provider calls", async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, "preview");
  f.write([f.row("first"), f.row("second")]);
  const args = ["image", "batch", "--manifest", f.manifest, "--output", output];
  const plan = JSON.parse(f.run([...args, "--dry-run", "--json"]).stdout);
  assert.equal(plan.comparisons.length, 2);
  assert.equal(plan.concurrency, 2);
  assert.equal(plan.comparisons[0].judge.model, "gpt-6.1-sol");
  for (const extra of [
    ["--concurrency", "0"],
    ["--concurrency", "NaN"],
    ["--json"],
    ["--typo"],
    ["--dry-run=false"],
  ])
    f.run([...args, ...extra], 1);
  f.write([f.row("first"), { ...f.row("second"), candidate: "missing.png" }]);
  f.run(args, 1);
  f.write([f.row("first"), f.row("FIRST")]);
  f.run(args, 1);
  f.write([f.row("CON")]);
  f.run(args, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(f.events().length, 0);
  assert.match(f.run(["image", "--help"]).stdout, /batch/);
  assert.match(f.run(["image", "batch", "--help"]).stdout, /--reuse/);
});

test("batch reports every result and reuses completed negative verdicts without rerolling", async (t) => {
  const f = await fixture(t),
    first = path.join(f.root, "first"),
    second = path.join(f.root, "second");
  f.write([f.row("passing"), f.row("negative")]);
  // Set strict preference only for the second pair: observed equivalence fails it.
  const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
  manifest.comparisons[1].policy = "preference";
  manifest.comparisons[1].candidate = "image.svg";
  manifest.comparisons[1].reference = "image.svg";
  fs.writeFileSync(f.manifest, JSON.stringify(manifest));
  f.run(["image", "batch", "--manifest", f.manifest, "--output", first], 2);
  assert.equal(
    (await sharp(path.join(first, "pairs/negative/reference-preview.png")).metadata()).format,
    "png",
  );
  const report = f.summary(first);
  assert.equal(report.passed, 1);
  assert.equal(report.failedOrInconclusive, 1);
  assert.equal(report.accepted, false);
  assert.equal(f.events().filter((e) => e.event === "start").length, 4);
  f.run(["image", "batch", "--manifest", f.manifest, "--reuse", first, "--output", second], 2);
  assert.equal(f.events().filter((e) => e.event === "start").length, 4);
  assert.ok(f.summary(second).comparisons.every((r: { reusedFrom?: string }) => r.reusedFrom));
  f.run(["image", "batch", "--resume", second], 2);
  assert.equal(f.events().filter((e) => e.event === "start").length, 4);
  const html = fs.readFileSync(path.join(second, "report.html"), "utf8");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  for (const row of f.summary(second).comparisons) {
    assert.equal(verifyArtifactIndex(path.join(second, row.run), { require: true }).ok, true);
    assert.equal(
      verifyArtifactIndex(path.join(second, "pairs", row.id), { require: true }).ok,
      true,
    );
  }
  manifest.comparisons[1].criterion = "different criterion";
  fs.writeFileSync(f.manifest, JSON.stringify(manifest));
  const third = path.join(f.root, "third");
  f.run(["image", "batch", "--manifest", f.manifest, "--reuse", second, "--output", third], 2);
  assert.equal(f.events().filter((e) => e.event === "start").length, 6);
  assert.equal(f.summary(third).comparisons[0].reusedFrom !== undefined, true);
  assert.equal(f.summary(third).comparisons[1].reusedFrom, undefined);
  // The consolidated report is sealed as well as the underlying vote artifacts.
  f.run(["verify", "--run", third]);
  fs.appendFileSync(path.join(third, "report.html"), "changed totals");
  assert.match(f.run(["image", "batch", "--resume", third], 1).stderr, /integrity/i);
  // Changed retained inputs are rejected before any new calls.
  fs.writeFileSync(path.join(second, "pairs/negative/sources/reference.image"), "tampered");
  assert.match(f.run(["image", "batch", "--resume", second], 1).stderr, /integrity/i);
});

test("reuse preserves duplicate outcomes and reserves matching IDs before matching renamed rows", async (t) => {
  const f = await fixture(t, { inconclusive: "abstain" }),
    original = path.join(f.root, "original");
  const passing = f.row("passing", "shared criterion"),
    inconclusive = f.row("inconclusive", "shared criterion");
  const run = (output: string) =>
    f.run(["image", "batch", "--manifest", f.manifest, "--reuse", original, "--output", output], 2);
  const assertRetained = (output: string, sourceIds: string[]) => {
    const report = f.summary(output);
    assert.equal(report.failedOrInconclusive, 1);
    assert.equal(report.accepted, false);
    for (let i = 0; i < sourceIds.length; i++) {
      const id = sourceIds[i]!;
      assert.equal(report.comparisons[i].reusedFrom, path.join(original, "pairs", id));
      assert.deepEqual(
        report.comparisons[i].report,
        f.summary(original).comparisons.find((row: { id: string }) => row.id === id).report,
      );
    }
  };
  f.write([passing, inconclusive]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", original], 2);
  assert.equal(f.summary(original).passed, 1);
  assert.equal(f.summary(original).failedOrInconclusive, 1);
  assert.equal(f.events().filter((e) => e.event === "start").length, 4);

  const reordered = path.join(f.root, "reordered");
  f.write([inconclusive, passing]);
  run(reordered);
  assertRetained(reordered, ["inconclusive", "passing"]);
  assert.equal(f.events().filter((e) => e.event === "start").length, 4);
  f.run(["image", "batch", "--resume", reordered], 2);
  assertRetained(reordered, ["inconclusive", "passing"]);

  // A new row listed first must not consume a result belonging to a later row.
  const expanded = path.join(f.root, "expanded");
  f.write([f.row("new", "shared criterion"), inconclusive, passing]);
  run(expanded);
  const expandedReport = f.summary(expanded);
  assert.equal(expandedReport.passed, 2);
  assert.equal(expandedReport.failedOrInconclusive, 1);
  assert.equal(expandedReport.comparisons[0].reusedFrom, undefined);
  assert.equal(expandedReport.comparisons[1].reusedFrom, path.join(original, "pairs/inconclusive"));
  assert.equal(expandedReport.comparisons[2].reusedFrom, path.join(original, "pairs/passing"));
  assert.equal(f.events().filter((e) => e.event === "start").length, 6);

  // Renaming every row can still reuse each distinct prior result exactly once.
  const renamed = path.join(f.root, "renamed");
  f.write([
    f.row("renamed-first", "shared criterion"),
    f.row("renamed-second", "shared criterion"),
  ]);
  run(renamed);
  assertRetained(renamed, ["passing", "inconclusive"]);
  assert.equal(f.events().filter((e) => e.event === "start").length, 6);
});

test("reuse rejects output inside the sealed source, including aliases and default output", async (t) => {
  const f = await fixture(t),
    original = path.join(f.root, "original"),
    alias = path.join(f.root, "alias");
  f.write([f.row("passing")]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", original]);
  const seal = fs.readFileSync(path.join(original, "artifact-index.json"), "utf8");
  fs.symlinkSync(original, alias, "dir");
  for (const output of [path.join(original, "revised"), path.join(alias, "revised")]) {
    const result = f.run(
      ["image", "batch", "--manifest", f.manifest, "--reuse", original, "--output", output],
      1,
    );
    assert.match(result.stderr, /outside the reused batch/i);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.readFileSync(path.join(original, "artifact-index.json"), "utf8"), seal);
    assert.equal(verifyArtifactIndex(original, { require: true }).ok, true);
  }
  const result = f.run(
    ["image", "batch", "--manifest", f.manifest, "--reuse", original],
    1,
    original,
  );
  assert.match(result.stderr, /outside the reused batch/i);
  assert.equal(fs.existsSync(path.join(original, ".agent-eval/image-batches")), false);
  assert.equal(verifyArtifactIndex(original, { require: true }).ok, true);
  f.run(["image", "batch", "--resume", original]);
  assert.equal(f.events().filter((e) => e.event === "start").length, 2);
});

test("an early queue error preserves later completed results on reuse and resume", async (t) => {
  const f = await fixture(t, { inconclusive: "abstain" }),
    original = path.join(f.root, "original"),
    output = path.join(f.root, "failed-batch");
  f.write([f.row("inconclusive")]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", original], 2);
  const retained = f.summary(original).comparisons[0].report;
  f.write([f.row("fail"), f.row("inconclusive"), f.row("later")]);
  fs.writeFileSync(f.fail, "fail");
  f.run(
    [
      "image",
      "batch",
      "--manifest",
      f.manifest,
      "--reuse",
      original,
      "--output",
      output,
      "--concurrency",
      "1",
    ],
    1,
  );
  const assertRetained = () => {
    const report = f.summary(output);
    assert.equal(report.errors, 1);
    assert.equal(report.completed, 1);
    assert.equal(report.failedOrInconclusive, 1);
    assert.equal(report.pending, 1);
    assert.equal(report.comparisons[0].status, "error");
    const row = report.comparisons[1];
    assert.equal(row.id, "inconclusive");
    assert.equal(row.status, "complete");
    assert.deepEqual(row.report, retained);
    assert.ok(
      fs.readFileSync(path.join(output, "report.html"), "utf8").includes(`${row.run}/report.html`),
    );
    assert.equal(
      f.events().filter((e) => e.key === "inconclusive" && e.event === "start").length,
      2,
    );
    assert.equal(
      f.events().some((e) => e.key === "later"),
      false,
    );
    assert.equal(verifyArtifactIndex(output, { require: true }).ok, true);
  };
  assertRetained();
  f.run(["image", "batch", "--resume", output], 1);
  assertRetained();
  fs.rmSync(f.fail);
  f.run(["image", "batch", "--resume", output], 2);
  assert.equal(f.summary(output).completed, 3);
  assert.equal(f.summary(output).failedOrInconclusive, 1);
  assert.equal(f.summary(output).passed, 2);
  assert.equal(f.events().filter((e) => e.key === "inconclusive" && e.event === "start").length, 2);
});

test("an execution error drains healthy work, leaves later rows pending and resumes fixed evidence", async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, "resume");
  fs.writeFileSync(f.fail, "fail");
  f.write([f.row("fail"), f.row("slow"), f.row("later")]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", output, "--concurrency", "2"], 1);
  const first = f.summary(output);
  assert.equal(first.errors, 1);
  assert.equal(first.completed, 1);
  assert.equal(first.pending, 1);
  assert.equal(f.events().filter((e) => e.key === "slow" && e.event === "start").length, 2);
  assert.equal(
    f.events().some((e) => e.key === "later"),
    false,
  );
  const pending = path.join(output, "pairs/later/sources/candidate.image");
  const original = fs.readFileSync(pending);
  // Simulate a process dying during report checkpointing: input and completed
  // vote seals must still protect the pending pair without a final batch seal.
  fs.rmSync(path.join(output, "artifact-index.json"));
  fs.writeFileSync(pending, "tampered pending input");
  assert.match(f.run(["image", "batch", "--resume", output], 1).stderr, /integrity/i);
  fs.writeFileSync(pending, original);
  fs.writeFileSync(path.join(output, "report.html"), "interrupted report checkpoint");
  fs.rmSync(f.fail);
  fs.rmSync(path.join(f.root, "image.png"));
  fs.rmSync(f.manifest);
  f.run(["image", "batch", "--resume", output]);
  assert.equal(f.summary(output).passed, 3);
  assert.equal(f.events().filter((e) => e.key === "slow" && e.event === "start").length, 2);
  f.run(["image", "batch", "--resume", output, "--concurrency", "1"], 1);
});

test("batch resume recovers an empty child reservation after receipt initialization fails", async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, "receipt-recovery");
  f.write([f.row("ready")]);
  fs.writeFileSync(f.versionFailure, "fail once");
  assert.match(
    f.run(["image", "batch", "--manifest", f.manifest, "--output", output], 1).stderr,
    /Unable to determine codex CLI version/,
  );
  const runs = path.join(output, "pairs/ready/.agent-eval/runs");
  assert.equal(fs.readdirSync(runs).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(runs, fs.readdirSync(runs)[0]!)), []);
  assert.equal(f.events().length, 0);
  f.run(["image", "batch", "--resume", output]);
  assert.equal(fs.readdirSync(runs).length, 1);
  assert.equal(f.summary(output).passed, 1);
  assert.equal(f.events().filter((e) => e.event === "start").length, 2);
  assert.equal(verifyArtifactIndex(output, { require: true }).ok, true);
});

test("batch resume refuses nonempty child directories without run state", async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, "missing-state");
  f.write([f.row("ready")]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", output]);
  const run = path.join(output, f.summary(output).comparisons[0].run),
    report = fs.readFileSync(path.join(run, "report.json"), "utf8");
  fs.rmSync(path.join(run, "run-state.json"));
  fs.rmSync(path.join(output, "artifact-index.json"));
  assert.match(
    f.run(["image", "batch", "--resume", output], 1).stderr,
    /missing run-state.json.*contains artifacts/i,
  );
  assert.equal(fs.readFileSync(path.join(run, "report.json"), "utf8"), report);
  assert.equal(f.events().filter((e) => e.event === "start").length, 2);
});

test("capacity retries retain the first vote and failed invocation without restarting the comparison", async (t) => {
  const f = await fixture(t),
    output = path.join(f.root, "capacity-review");
  fs.writeFileSync(f.capacity, "capacity");
  f.write([f.row("capacity")]);
  f.run(["image", "batch", "--manifest", f.manifest, "--output", output]);
  assert.equal(f.summary(output).passed, 1);
  assert.equal(f.events().filter((e) => e.event === "start").length, 3);
  const run = path.join(output, f.summary(output).comparisons[0].run);
  const votes = path.join(run, "areas/image/pairwise/COMPARISON/IMAGE/1");
  assert.equal(fs.existsSync(path.join(votes, "vote-01/vote.json")), true);
  assert.match(
    fs.readFileSync(
      path.join(votes, "vote-02/capacity-retries/attempt-1/provider-events.ndjson"),
      "utf8",
    ),
    /at capacity/,
  );
  assert.equal(verifyArtifactIndex(run, { require: true }).ok, true);
  f.run(["image", "batch", "--resume", output]);
  assert.equal(f.events().filter((e) => e.event === "start").length, 3);
});
