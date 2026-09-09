import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertToolchain, deliveryIssues, probe, decode, hash } from "./media.mjs";
import { decideVotes } from "../../src/visual/votes.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = parse(await fs.readFile(new URL("./evalkit.yaml", import.meta.url), "utf8"));
const spec = parse(await fs.readFile(new URL("./evals/specs/video.yaml", import.meta.url), "utf8"));
test("Judge policy uses exactly the requested model, bounded voting and a single batch", () => {
  assert.equal(config.judge.model, "gpt-6-astra");
  assert.equal(config.judge.effort, "medium");
  assert.ok(spec.scenarios[0].collect.images.length <= 30);
  assert.equal(config.judge.voting.minimumVotes, 3);
  assert.equal(config.judge.voting.maximumVotes, 5);
  assert.ok(config.judge.concurrency <= 3);
  assert.equal(spec.rubric.filter((r) => r.grader.type === "pairwise").length, 0);
  const policy = config.judge.voting;
  assert.equal(decideVotes(["pass", "pass"], policy, ["pass"]).decision, "continue");
  assert.equal(decideVotes(["pass", "pass", "pass"], policy, ["pass"]).decision, "pass");
  assert.equal(decideVotes(["pass", "fail", "pass"], policy, ["pass"]).decision, "continue");
  assert.equal(
    decideVotes(["pass", "fail", "pass", "pass"], policy, ["pass"]).decision,
    "continue",
  );
  assert.equal(
    decideVotes(["pass", "fail", "pass", "pass", "pass"], policy, ["pass"]).decision,
    "pass",
  );
  assert.equal(
    decideVotes(["pass", "fail", "pass", "fail", "pass"], policy, ["pass"]).decision,
    "inconclusive",
  );
  assert.equal(
    decideVotes(["abstain", "abstain", "pass", "pass", "pass"], policy, ["pass"]).decision,
    "inconclusive",
  );
  assert.equal(decideVotes(["fail", "fail", "fail"], policy, ["pass"]).decision, "fail");
});
test("Actual exports decode and conform; checker rejects audio, wrong duration and wrong geometry", async () => {
  await assertToolchain();
  for (const [name, dimensions] of Object.entries({
    landscape: { width: 1920, height: 1080 },
    portrait: { width: 1080, height: 1350 },
  })) {
    const file = path.join(root, `.agent-eval/marketing-video/${name}.mp4`);
    const metadata = probe(file);
    decode(file);
    assert.deepEqual(deliveryIssues(metadata, dimensions), []);
    const withAudio = structuredClone(metadata);
    withAudio.streams.push({ codec_type: "audio" });
    assert.match(deliveryIssues(withAudio, dimensions).join(" "), /no audio/);
    const short = structuredClone(metadata);
    short.format.duration = "29";
    assert.match(deliveryIssues(short, dimensions).join(" "), /100-second/);
    const badFrames = structuredClone(metadata);
    badFrames.streams[0].nb_frames = "2999";
    assert.match(deliveryIssues(badFrames, dimensions).join(" "), /3,000/);
    assert.ok(deliveryIssues(metadata, { width: 720, height: 720 }).length);
  }
});
test("Reference bytes match reviewed targets and every sample is within its film", async () => {
  const { references } = JSON.parse(
    await fs.readFile(new URL("./references.json", import.meta.url), "utf8"),
  );
  assert.equal(references.length, 3);
  for (const ref of references) {
    const file = path.join(root, `.agent-eval/marketing-video/references/${ref.id}.mp4`);
    const bytes = await fs.readFile(file);
    assert.equal(hash(bytes), ref.sha256);
    assert.equal(bytes.length, ref.bytes);
    const metadata = probe(file);
    assert.ok(ref.times.every((time) => time >= 0 && time < Number(metadata.format.duration)));
  }
});

test("The same cart story exposes the defect, retests the fix and confirms payment", async () => {
  const { cartState, panelState, sceneAt, scenes, sampleTimes, DURATION } = await import(
    "./src/story.mjs"
  );
  assert.equal(DURATION, 100);
  assert.deepEqual(cartState("run", 1), {
    quantity: 1,
    total: 120,
    expected: 120,
    confirmed: false,
  });
  assert.deepEqual(cartState("run", 6), {
    quantity: 2,
    total: 120,
    expected: 240,
    confirmed: false,
  });
  assert.deepEqual(cartState("retest", 4), {
    quantity: 2,
    total: 240,
    expected: 240,
    confirmed: false,
  });
  assert.equal(cartState("retest", 6.5).confirmed, true);
  assert.throws(() => cartState("story", 3), /Not a checkout/);
  assert.equal(panelState(3.5).count, 3);
  assert.match(panelState(3.5).decision, /INCONCLUSIVE/);
  assert.equal(panelState(6).count, 5);
  assert.equal(panelState(6).votes.length, 3);
  assert.equal(panelState(9).votes.filter((v) => v === "PASS").length, 4);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes.at(-1).end, DURATION);
  for (let i = 1; i < scenes.length; i++) assert.equal(scenes[i].start, scenes[i - 1].end);
  for (const scene of scenes)
    assert.ok(
      sampleTimes.some((t) => sceneAt(t) === scene),
      `Unsampled scene: ${scene.kind}`,
    );
  assert.throws(() => sceneAt(100), /outside video/);
});

test("The combined cut preserves the old mechanisms and completes the faster demo", async () => {
  const { scenes, sampleGroups } = await import("./src/story.mjs");
  assert.equal(scenes.find((s) => s.kind === "retest").end, 37);
  for (const kind of ["summit", "loop", "rubric", "sources", "inspect", "coverage", "climb"])
    assert.ok(scenes.some((s) => s.kind === kind));
  assert.equal(scenes[0].kind, "summit");
  assert.equal(scenes[0].start, 0);
  assert.equal(sampleGroups.length, 12);
  assert.ok(sampleGroups.every((g) => g.length <= 2));
  const retest = scenes.find((s) => s.kind === "retest");
  assert.ok(
    retest.end - retest.start - 4.8 / retest.speed >= 2,
    "Keep a readable confirmation hold",
  );
});

test("Evidence precedes the fix and the candidate moves continuously through evaluation", async () => {
  const { scenes, carrierAt, WORKFLOW_KINDS, climbState } = await import("./src/story.mjs");
  assert.ok(
    scenes.find((s) => s.kind === "inspect").end <= scenes.find((s) => s.kind === "edit").start,
  );
  const sequence = scenes.filter((s) => WORKFLOW_KINDS.includes(s.kind));
  for (let i = 1; i < sequence.length; i++) assert.equal(sequence[i - 1].end, sequence[i].start);
  for (const portrait of [false, true]) {
    for (const scene of sequence.slice(1)) {
      const a = carrierAt(scene.start - 0.0001, portrait),
        b = carrierAt(scene.start, portrait);
      for (const key of Object.keys(a))
        assert.ok(Math.abs(a[key] - b[key]) < 1, `Carrier jumps at ${scene.start}s: ${key}`);
    }
    assert.deepEqual(carrierAt(63, portrait), carrierAt(67, portrait));
    for (let frame = 37 * 30; frame < 77 * 30; frame++) {
      const { x, y, w, h } = carrierAt(frame / 30, portrait);
      assert.ok(w > 0 && h > 0 && x >= 0 && y >= 225);
      assert.ok(x + w <= (portrait ? 1080 : 1920));
      assert.ok(y + h < (portrait ? 1280 : 1030), "Carrier must clear the footer");
    }
  }
  assert.deepEqual(climbState(3), { best: 68, status: "rejected", step: 2 });
  assert.deepEqual(climbState(7), { best: 82, status: "withheld", step: 4 });
  assert.deepEqual(climbState(10), { best: 91, status: "accepted", step: 5 });
});
