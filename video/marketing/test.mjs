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
    assert.match(deliveryIssues(short, dimensions).join(" "), /40-second/);
    const badFrames = structuredClone(metadata);
    badFrames.streams[0].nb_frames = "1199";
    assert.match(deliveryIssues(badFrames, dimensions).join(" "), /1,200/);
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
