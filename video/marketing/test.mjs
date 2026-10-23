import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertToolchain, deliveryIssues, probe, decode, hash } from "./media.mjs";
import { loadEvidence } from "./evidence.mjs";
import { loadWorkflow } from "./workflow.mjs";
import { hashTarget } from "./improvement/snapshot.mjs";
import { renderInputs, verifyExport } from "./release.mjs";
import { CUTS, FORMATS, FPS, sceneAt, sampleTimes, exportName, captionVtt } from "./src/story.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".agent-eval/marketing-video");

test("Every frame and caption belongs to one scene; the findings precede each revision", () => {
  for (const [cut, definition] of Object.entries(CUTS)) {
    for (let frame = 0; frame < definition.duration * FPS; frame++) {
      const time = frame / FPS;
      assert.equal(definition.scenes.filter((s) => time >= s.start && time < s.end).length, 1);
      assert.ok(sceneAt(time, cut));
    }
    assert.throws(() => sceneAt(definition.duration, cut), /outside video/);
    assert.equal(captionVtt(cut).match(/ --> /g).length, definition.scenes.length);
  }
  assert.throws(() => sceneAt(NaN), /outside video/);
  const scenes = CUTS.main.scenes;
  for (const scene of scenes)
    assert.ok(
      sampleTimes.some((time) => sceneAt(time) === scene),
      `Missing sample for ${scene.kind}`,
    );
  for (const cut of Object.keys(CUTS)) {
    const kinds = CUTS[cut].scenes.map((scene) => scene.kind);
    const expected =
      cut === "social"
        ? ["hook", "dispatchFinding", "measured", "compare", "close"]
        : [
            "hook",
            "target",
            "dispatchFinding",
            "dispatchRevision",
            "measured",
            "result",
            "compare",
            "close",
          ];
    const positions = expected.map((kind) => kinds.indexOf(kind));
    assert.ok(
      positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
      cut,
    );
    if (cut !== "walkthrough") {
      assert.ok(
        !kinds.includes("finding") && !kinds.includes("first"),
        "Dashboard belongs only in the walkthrough",
      );
      assert.ok(CUTS[cut].scenes.every((scene) => !scene.illustrative));
    }
  }
  const walkthrough = CUTS.walkthrough.scenes;
  for (const kind of ["regression", "coverage"]) {
    const scene = walkthrough.find((scene) => scene.kind === kind);
    assert.equal(scene.illustrative, true);
    assert.match(scene.caption, /Illustrative policy example/);
  }
  assert.match(
    walkthrough.find((scene) => scene.kind === "regression").caption,
    /coding agent rejects/,
  );
  assert.match(
    walkthrough.find((scene) => scene.kind === "coverage").caption,
    /unscored.*coverage.*withheld.*execution errors remain errors/,
  );
  assert.ok(
    walkthrough.find((scene) => scene.kind === "finding").start >
      walkthrough.find((scene) => scene.kind === "compare").end,
  );
});

test("The film follows actual revisions against an unchanged evaluator", async () => {
  const proof = await loadEvidence();
  const fingerprints = new Set();
  for (const name of ["baseline", "proportions", "overview", "repeat"]) {
    const actual = JSON.parse(
      await fs.readFile(path.join(root, proof.artifacts[name], "report.json"), "utf8"),
    );
    const shown = proof.results[name];
    assert.equal(shown.score, actual.overallScorePct);
    assert.equal(shown.coverage, actual.overallCoveragePct);
    assert.equal(shown.gate, actual.gates.passed);
    assert.equal(shown.coverage, 100);
    fingerprints.add(shown.fingerprint);
    for (const item of actual.areas.flatMap((area) => area.items)) {
      assert.equal(shown.items[item.id].verdict, item.verdict);
      assert.equal(shown.items[item.id].reasoning, item.reasoning);
    }
  }
  assert.equal(fingerprints.size, 1);
  assert.equal(proof.results.baseline.items.DATA.verdict, "fail");
  assert.equal(proof.results.proportions.items.DATA.verdict, "pass");
  assert.equal(proof.results.proportions.items.OVERVIEW.verdict, "partial");
  assert.equal(proof.results.overview.items.OVERVIEW.verdict, "pass");
  assert.deepEqual(
    Object.values(proof.results.repeat.items).map((item) => item.verdict),
    ["pass", "pass", "pass"],
  );
  const original = await fs.readFile(path.join(root, proof.session, "original.html"));
  assert.equal(hash(original), proof.origin.sha256);
  assert.equal(
    hash(await fs.readFile(path.join(root, proof.session, "baseline.html"))),
    proof.origin.sha256,
  );
  const journal = (await fs.readFile(path.join(root, proof.session, "journal.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    journal.map((entry) => entry.label),
    ["baseline", "proportions", "overview", "repeat"],
  );
  assert.equal(journal[2].sha256, journal[3].sha256);
  const observed = JSON.parse(
    await fs.readFile(
      path.join(root, proof.artifacts.overview, "DASHBOARD/collector-output/observations.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    observed.desktopWeekly.rows.map((row) => row.value),
    [140, 180, 110],
  );
  assert.match(observed.desktopWeekly.text, /430/);
  assert.match(observed.desktopWeekly.text, /Central/);
  for (const key of [
    "baselineDesktop",
    "baselineMobile",
    "proportionsDesktop",
    "proportionsMobile",
    "overviewDesktop",
    "overviewMobile",
  ])
    assert.match(proof.screenshots[key].src, /^data:image\/png;base64,/);
  const bars = Object.fromEntries(proof.phoneRows.baseline.map((row) => [row.region, row]));
  assert.ok(bars.Central.value > bars.North.value && bars.Central.bar.width < bars.North.bar.width);
});

test("All six exports fully decode and match their own duration, geometry and evidence", async () => {
  await assertToolchain();
  const inputs = await renderInputs(root);
  for (const [cut, definition] of Object.entries(CUTS))
    for (const [format, dimensions] of Object.entries(FORMATS)) {
      const name = exportName(cut, format),
        file = path.join(output, "exports", name, "video.mp4");
      const metadata = probe(file);
      decode(file);
      assert.deepEqual(deliveryIssues(metadata, dimensions, definition.duration), []);
      const directory = await fs.realpath(path.join(output, "exports", name));
      await verifyExport(directory, { cut, format, duration: definition.duration, ...inputs });
      assert.equal(
        await fs.readFile(path.join(directory, "captions.vtt"), "utf8"),
        captionVtt(cut),
      );
      const invalid = structuredClone(metadata);
      invalid.streams.push({ codec_type: "audio" });
      assert.match(deliveryIssues(invalid, dimensions, definition.duration).join(" "), /no audio/);
      invalid.streams.pop();
      invalid.format.duration = "19";
      assert.match(deliveryIssues(invalid, dimensions, definition.duration).join(" "), /second/);
      assert.ok(deliveryIssues(metadata, { width: 720, height: 720 }, definition.duration).length);
    }
});

test("The after is the evaluated, published and captured dispatch revision", async () => {
  const workflow = await loadWorkflow();
  for (const size of ["desktop", "mobile"]) {
    assert.match(workflow.observations[`${size}Before`], /14:52/);
    assert.match(workflow.observations[`${size}Choices`], /No temperature-controlled vehicle/);
    assert.match(workflow.observations[`${size}After`], /Leo Chen/);
    assert.match(workflow.observations[`${size}After`], /14:18/);
    assert.deepEqual(workflow.observations[`${size}Checks`], {
      reassignment: true,
      persistedAfterReload: true,
      undo: true,
      shipmentCount: 9,
      errors: [],
    });
  }
  const { facts } = workflow;
  assert.deepEqual(
    [
      facts.shipment.name,
      facts.shipment.eta,
      facts.shipment.due,
      facts.after.eta,
      facts.after.driver,
    ],
    ["Riverton Medical", "14:52", "14:30", "14:18", "Leo Chen"],
  );
  const rejected = facts.options.find((o) => !o.eligible),
    chosen = facts.options.find((o) => o.eligible);
  assert.equal(chosen.name, facts.after.driver);
  assert.ok(rejected.eta < chosen.eta, "The film says the ineligible driver arrives sooner");
  assert.match(rejected.reason, /temperature-controlled/);

  // The film's dispatch scores are the retained reports, from one unchanged evaluator.
  const results = workflow.evaluation.results;
  assert.equal(results[0].label, "baseline");
  assert.equal(results.at(-1).label, "repeat");
  for (const result of results) {
    const report = JSON.parse(
      await fs.readFile(path.join(root, result.run, "report.json"), "utf8"),
    );
    assert.equal(result.score, report.overallScorePct);
    assert.equal(result.coverage, 100);
    for (const item of report.areas.flatMap((area) => area.items))
      assert.equal(result.items[item.id].verdict, item.verdict);
  }
  assert.equal(new Set(results.map((r) => r.fingerprint)).size, 1);
  const [baseline, final, repeat] = [results[0], results.at(-2), results.at(-1)];
  assert.ok(results.slice(1, -1).every((r, i) => r.score > results[i].score));
  assert.deepEqual([repeat.sha256, repeat.score], [final.sha256, final.score]);
  assert.ok(Object.values(final.items).every((item) => item.verdict === "pass"));
  // On-screen finding copy must match what AEK reported.
  assert.equal(baseline.items.PHONE.verdict, "fail");
  assert.match(baseline.items.PHONE.reasoning, /nested scroll/);
  assert.match(baseline.items.PHONE.reasoning, /9px/);
  for (const cut of ["main", "walkthrough"]) {
    const caption = CUTS[cut].scenes.find((scene) => scene.kind === "measured").caption;
    assert.ok(caption.includes(`${Math.round(baseline.score)}%`), cut);
    assert.ok(caption.includes(`${Math.round(final.score)}%`), cut);
  }
  const teaser = CUTS.social.scenes.find((scene) => scene.kind === "measured").caption;
  assert.ok(
    teaser.includes(`${Math.round(baseline.score)}%`) &&
      teaser.includes(`${Math.round(final.score)}%`),
  );
  assert.equal(
    hashTarget(path.join(root, "video/marketing/assets/dispatch-baseline")),
    baseline.sha256,
  );
  assert.notEqual(baseline.sha256, final.sha256);
  for (const key of [
    "desktopBaseline",
    "mobileQueueBaseline",
    "mobileQueueRevision",
    "mobileQueueFinal",
  ])
    assert.ok(workflow.screenshots[key].src.startsWith("data:image/png;base64,"), key);

  // The published prototype is the evaluated final revision, byte for byte.
  const published = path.join(root, workflow.published.path);
  assert.equal(hashTarget(published), workflow.published.sha256);
  assert.equal(workflow.published.sha256, final.sha256);
  for (const name of await fs.readdir(published))
    assert.deepEqual(
      await fs.readFile(path.join(published, name)),
      await fs.readFile(path.join(root, workflow.session, "site", name)),
      name,
    );
  for (const directory of Object.values(workflow.evaluation.comparisons))
    assert.ok(workflow.sources.some((source) => source.path.startsWith(directory + "/")));
  assert.match(workflow.scope, /earlier dashboard verdicts do not score this workflow/);
});

test("Pinned creative references retain their approved bytes and sampling limits", async () => {
  const { references } = JSON.parse(
    await fs.readFile(new URL("./references.json", import.meta.url), "utf8"),
  );
  for (const ref of references) {
    const file = path.join(output, `references/${ref.id}.mp4`);
    const bytes = await fs.readFile(file);
    assert.equal(hash(bytes), ref.sha256);
    assert.equal(bytes.length, ref.bytes);
    assert.ok(ref.times.every((time) => time >= 0 && time < Number(probe(file).format.duration)));
  }
  const spec = parse(
    await fs.readFile(new URL("./evals/specs/video.yaml", import.meta.url), "utf8"),
  );
  assert.ok(spec.scenarios[0].collect.images.length <= 30);
});
