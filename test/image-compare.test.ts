import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import YAML from "yaml";
import { verifyArtifactIndex } from "../src/integrity.js";
import { MAX_IMAGE_BYTES, sourceImage } from "../src/visual/images.js";

const cli = path.resolve("src/cli.ts");
const tsx = import.meta.resolve("tsx");
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-image-compare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate's picture.png");
  const reference = path.join(root, "reference.png");
  const bytes = await sharp({
    create: { width: 24, height: 16, channels: 4, background: "#357abc" },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(candidate, bytes);
  fs.writeFileSync(reference, bytes);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const counter = path.join(root, "calls");
  const fail = path.join(root, "fail");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex fixture 1');process.exit(0)}
const counter=${JSON.stringify(counter)};
const count=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;
fs.writeFileSync(counter,String(count));
if(count===2&&fs.existsSync(${JSON.stringify(fail)}))process.exit(19);
const result={preferred:'equivalent',confidence:0.95,reasoning:'Equivalent fixture panels.',findings:[]};
const text=JSON.stringify(result);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`,
    { mode: 0o755 },
  );
  function run(args: string[], expected = 0) {
    const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result;
  }
  const args = [
    "image",
    "compare",
    "--candidate",
    candidate,
    "--reference",
    reference,
    "--criterion",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: criteria must remain literal user text.
    "Readable labels: 'clear' & ${literal} `text`",
    "--width",
    "64",
    "--height",
    "64",
  ];
  function runDir(output: string) {
    const runs = path.join(output, ".agent-eval/runs");
    const entries = fs.readdirSync(runs);
    assert.equal(entries.length, 1);
    return path.join(runs, entries[0]!);
  }
  return { root, candidate, reference, bytes, counter, fail, args, run, runDir };
}

test("image comparison decodes SVG inputs with the patched image engine", async (t) => {
  const f = await fixture(t);
  const svg = path.join(f.root, "candidate.svg");
  fs.writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#357abc"/></svg>',
  );
  const plan = JSON.parse(
    f.run([...f.args, "--candidate", svg, "--reference", svg, "--dry-run", "--json"]).stdout,
  );
  assert.equal(plan.candidate.format, "svg");
  assert.equal(plan.candidate.width, 24);
  assert.equal(plan.candidate.height, 16);
  const decoded = await sourceImage(fs.readFileSync(svg));
  assert.deepEqual(
    await sharp(decoded).raw().toBuffer(),
    await sharp(f.bytes).removeAlpha().raw().toBuffer(),
  );
  assert.equal(fs.existsSync(f.counter), false);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-eval")), false);
});

test("image comparison dry-run validates inputs and defaults without creating output or invoking providers", async (t) => {
  const f = await fixture(t);
  const plan = JSON.parse(f.run([...f.args, "--dry-run", "--json"]).stdout);
  assert.equal(plan.policy, "non_regression");
  assert.equal(plan.judge.provider, "codex");
  assert.equal(plan.voting.minimumVotes, 5);
  assert.equal(plan.voting.maximumVotes, 9);
  assert.equal(plan.candidate.width, 24);
  assert.equal(plan.candidate.sha256, plan.reference.sha256);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-eval")), false);
  assert.equal(fs.existsSync(f.counter), false);
  const output = path.join(f.root, "invalid-output");
  for (const extra of [
    ["--policy", "invalid"],
    ["--judge", "invalid"],
    ["--agreement", "0.5"],
    ["--minimum-votes", "4", "--maximum-votes", "2"],
    ["--width", "2001"],
    ["--height", "1.5"],
    ["--timeout-seconds", "NaN"],
    ["--timeout-seconds", "0.5"],
    ["--criterion", " "],
    ["--typo"],
    ["--json"],
    ["--dry-run=false"],
    ["extra"],
    ["--candidate", path.join(f.root, "missing")],
    ["--reference", f.root],
    ["--reference", "https://example.test/reference.png"],
  ])
    f.run([...f.args, "--output", output, ...extra], 1);
  fs.writeFileSync(f.reference, "not an image");
  assert.match(f.run([...f.args, "--output", output], 1).stderr, /Invalid reference image/);
  fs.writeFileSync(
    f.reference,
    Buffer.from(
      "R0lGODlhAQABAIAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEADs=",
      "base64",
    ),
  );
  assert.match(f.run([...f.args, "--output", output], 1).stderr, /Animated and multi-page/);
  // A valid one-frame APNG still declares animation; sharp exposes only its PNG frame.
  const animationChunks = Buffer.from(
    "000000086163544c0000000100000000b42de9a00000001a6663544c00000000000000180000001000000000000000000001000a00006ae7d2a0",
    "hex",
  );
  fs.writeFileSync(
    f.reference,
    Buffer.concat([f.bytes.subarray(0, 33), animationChunks, f.bytes.subarray(33)]),
  );
  assert.match(f.run([...f.args, "--output", output], 1).stderr, /Animated and multi-page/);
  fs.writeFileSync(
    f.reference,
    '<svg xmlns="http://www.w3.org/2000/svg" width="400001" height="1000"/>',
  );
  assert.match(f.run([...f.args, "--output", output], 1).stderr, /pixel limit/);
  fs.truncateSync(f.reference, 26 * 1024 * 1024);
  assert.match(f.run([...f.args, "--output", output], 1).stderr, /25 MiB/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(f.counter), false);
});

test("compressed candidates that exceed the PNG evidence limit fail before output or provider calls", async (t) => {
  const f = await fixture(t);
  const pixels = Buffer.allocUnsafe(3500 * 3000 * 3);
  let seed = 1337;
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[i] = seed & 255;
  }
  const jpeg = await sharp(pixels, { raw: { width: 3500, height: 3000, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
  assert.ok(jpeg.length < MAX_IMAGE_BYTES, "The compressed source must satisfy the input limit");
  assert.ok(
    (await sourceImage(jpeg)).length > MAX_IMAGE_BYTES,
    "Decoded evidence must exceed the reader limit",
  );
  const candidate = path.join(f.root, "large.jpg");
  fs.writeFileSync(candidate, jpeg);
  const output = path.join(f.root, "oversized-evidence");
  const args = [...f.args, "--candidate", candidate, "--output", output];
  for (const extra of [["--dry-run", "--json"], []]) {
    const result = f.run([...args, ...extra], 1);
    assert.match(result.stderr, /candidate.*decoded PNG evidence exceeds 25 MiB.*resize/s);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(f.counter), false);
  }
  // References are retained in their original format and normalized into bounded panels.
  f.run([...f.args, "--reference", candidate, "--dry-run", "--json"]);
});

test("direct image comparison seals originals, uses normal reports, and applies equivalence policies", async (t) => {
  const f = await fixture(t);
  for (const policy of ["non_regression", "preference"]) {
    const output = path.join(f.root, policy);
    f.run(
      [
        ...f.args,
        "--output",
        output,
        "--policy",
        policy,
        "--minimum-votes",
        "1",
        "--maximum-votes",
        "1",
      ],
      policy === "preference" ? 2 : 0,
    );
    const run = f.runDir(output);
    const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    assert.equal(report.overallCoveragePct, 100);
    assert.equal(report.gates.passed, policy === "non_regression");
    assert.equal(report.areas[0].items[0].verdict, policy === "non_regression" ? "pass" : "fail");
    assert.deepEqual(fs.readFileSync(path.join(output, "sources/candidate.image")), f.bytes);
    assert.deepEqual(fs.readFileSync(path.join(output, "sources/reference.image")), f.bytes);
    assert.equal(verifyArtifactIndex(run, { require: true }).ok, true);
    assert.equal(
      fs.existsSync(path.join(run, "areas/image/pairwise/COMPARISON/IMAGE/1/comparison.html")),
      true,
    );
    assert.match(f.run([...f.args, "--output", output], 1).stderr, /Refusing to overwrite/);
  }
});

test("direct image paths preserve filename whitespace and quotes", async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, " candidate's image.png ");
  const reference = path.join(f.root, " reference.png ");
  const output = path.join(f.root, " review's output ");
  fs.copyFileSync(f.candidate, candidate);
  fs.copyFileSync(f.reference, reference);
  const args = [
    ...f.args,
    "--candidate",
    candidate,
    "--reference",
    reference,
    "--output",
    output,
    "--judge",
    "mock",
    "--minimum-votes",
    "1",
    "--maximum-votes",
    "1",
  ];
  const plan = JSON.parse(f.run([...args, "--dry-run", "--json"]).stdout);
  assert.equal(plan.candidate.path, candidate);
  assert.equal(plan.reference.path, reference);
  assert.equal(plan.output, output);
  f.run(args, 2);
  const run = f.runDir(output);
  f.run(["verify", "--run", run]);
  f.run(["run", "--resume", run], 2);
});

test("mock image comparison and absolute criterion retain uncertainty instead of inventing a score", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.root, "mock");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: criteria must remain literal user text.
  const criterion = "All labels must be legible: ${literal} & 'quoted'";
  f.run(
    [
      ...f.args,
      "--output",
      output,
      "--judge",
      "mock",
      "--absolute-criterion",
      criterion,
      "--minimum-votes",
      "1",
      "--maximum-votes",
      "1",
    ],
    2,
  );
  const run = f.runDir(output);
  const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
  assert.equal(report.overallCoveragePct, 0);
  assert.equal(report.scoreWithheld, true);
  assert.equal(report.gates.passed, false);
  assert.deepEqual(
    report.areas[0].items.map((item: { verdict: string }) => item.verdict),
    ["cannot_judge", "cannot_judge"],
  );
  const spec = YAML.parse(fs.readFileSync(path.join(output, "specs/image.yaml"), "utf8"));
  assert.equal(spec.rubric[0].criterion, criterion);
  assert.equal(spec.rubric[0].gate, true);
  assert.equal(verifyArtifactIndex(run, { require: true }).ok, true);
  assert.equal(fs.existsSync(f.counter), false);
});

test("failed direct comparisons resume completed votes from retained inputs even after originals are removed", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.root, "resume");
  fs.writeFileSync(f.fail, "fail second vote");
  assert.match(
    f.run([...f.args, "--output", output, "--minimum-votes", "2", "--maximum-votes", "2"], 1)
      .stderr,
    /Pairwise judge execution failed/,
  );
  const run = f.runDir(output);
  const vote = path.join(run, "areas/image/pairwise/COMPARISON/IMAGE/1/vote-01/vote.json");
  const originalVote = fs.readFileSync(vote, "utf8");
  const evidenceFile = path.join(run, "IMAGE/evidence.json");
  const evidence = fs.readFileSync(evidenceFile, "utf8");
  fs.rmSync(f.candidate);
  fs.rmSync(f.reference);
  fs.rmSync(f.fail);
  f.run(["run", "--resume", run]);
  assert.equal(fs.readFileSync(f.counter, "utf8"), "3");
  assert.equal(fs.readFileSync(vote, "utf8"), originalVote);
  assert.equal(fs.readFileSync(evidenceFile, "utf8"), evidence);
  assert.equal(verifyArtifactIndex(run, { require: true }).ok, true);
  f.run(["verify", "--run", run]);
});
