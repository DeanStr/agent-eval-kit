import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import YAML from "yaml";
import { hash } from "./media.mjs";
import {
  assertEvaluatedSnapshot,
  assertSessionSnapshots,
  hashTarget,
} from "./improvement/snapshot.mjs";
import { decodeRecording, restoreRecording } from "./recording.mjs";
import { sealExport, verifyExport, publishExport, renderInputs } from "./release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJSON = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const run = (args, options = {}) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });

test("An edit between the wrapper snapshot and AEK input capture is an execution error", async () => {
  const prepared = run(["video/marketing/improvement/prepare.mjs", "dashboard"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const session = prepared.stdout.trim();
  const hooks = await fs.mkdtemp(path.join(os.tmpdir(), "aek-snapshot-test-"));
  try {
    const configPath = path.join(session, "project/evalkit.yaml");
    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    config.judge = { provider: "mock" };
    await fs.writeFile(configPath, YAML.stringify(config));
    const target = path.join(session, "project/dashboard.html");
    const hook = path.join(hooks, "edit.mjs");
    await fs.writeFile(
      hook,
      `import fs from 'node:fs';\n` +
        `if(process.argv[1]?.endsWith('/dist/cli.js') && process.argv[2] === 'run') ` +
        `fs.appendFileSync(${JSON.stringify(target)}, '\\n<!-- concurrent editor save -->\\n');\n`,
    );
    const result = run(
      ["video/marketing/improvement/run.mjs", session, "baseline", "Concurrent edit probe"],
      {
        env: { ...process.env, NODE_OPTIONS: `--import=${hook}` },
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const entry = JSON.parse(
      (await fs.readFile(path.join(session, "journal.ndjson"), "utf8")).trim(),
    );
    assert.match(entry.executionError, /Evaluated source DASHBOARD\/page differs from snapshot/);
    assert.equal(
      Object.hasOwn(entry, "score"),
      false,
      "Execution failures must not acquire scores",
    );
    const verified = run(["dist/cli.js", "verify", "--run", entry.run]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.throws(
      () => assertSessionSnapshots(root, path.relative(root, session), "dashboard"),
      /execution failure/,
    );
  } finally {
    await fs.rm(session, { recursive: true });
    await fs.rm(hooks, { recursive: true });
  }
});

test("Dispatch preparation retains the actual 70% baseline, and every evaluated file is bound", async () => {
  const manifest = await readJSON(path.join(root, ".agent-eval/marketing-video/workflow.json"));
  const baseline = manifest.evaluation.results[0];
  const report = await readJSON(path.join(root, baseline.run, "report.json"));
  const prepared = run(["video/marketing/improvement/prepare.mjs", "dispatch"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const session = prepared.stdout.trim(),
    snapshot = path.join(session, "original");
  try {
    assert.equal(hashTarget(snapshot), baseline.sha256);
    assert.notEqual(hashTarget(snapshot), manifest.published.sha256);
    assertEvaluatedSnapshot("dispatch", snapshot, baseline.sha256, report);
    for (const file of await fs.readdir(snapshot)) {
      const target = path.join(snapshot, file),
        original = await fs.readFile(target);
      await fs.appendFile(target, "changed");
      assert.throws(
        () => assertEvaluatedSnapshot("dispatch", snapshot, hashTarget(snapshot), report),
        /differs from snapshot/,
      );
      await fs.writeFile(target, original);
    }
    const missing = structuredClone(report);
    delete missing.receipt.inputs.collectorSources["WORKFLOW/font"];
    assert.throws(
      () => assertEvaluatedSnapshot("dispatch", snapshot, baseline.sha256, missing),
      /complete dispatch/,
    );
  } finally {
    await fs.rm(session, { recursive: true });
  }
});

test("The checked-in recording restores complete evidence into a fresh checkout without overwriting", async () => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "aek-recording-test-"));
  try {
    const restored = await restoreRecording(destination);
    assert.ok(restored.restored > 600);
    assert.equal(restored.restored, restored.verified);
    for (const [name, kind] of [
      ["evidence", "dashboard"],
      ["workflow", "dispatch"],
    ]) {
      const manifest = await readJSON(
        path.join(destination, `.agent-eval/marketing-video/${name}.json`),
      );
      const session = name === "evidence" ? manifest.session : manifest.evaluation.session;
      assertSessionSnapshots(destination, session, kind);
      const reports =
        name === "evidence"
          ? [
              manifest.artifacts.baseline,
              manifest.artifacts.proportions,
              manifest.artifacts.overview,
              manifest.artifacts.repeat,
            ]
          : manifest.evaluation.results.map((result) => result.run);
      for (const report of reports) {
        const verified = run(["dist/cli.js", "verify", "--run", path.join(destination, report)]);
        assert.equal(verified.status, 0, verified.stdout + verified.stderr);
      }
    }
    assert.equal((await restoreRecording(destination)).restored, 0);
    const file = path.join(destination, ".agent-eval/marketing-video/evidence.json");
    await fs.writeFile(file, "existing user session");
    await assert.rejects(restoreRecording(destination), /conflicts with/);
    assert.equal(await fs.readFile(file, "utf8"), "existing user session");
  } finally {
    await fs.rm(destination, { recursive: true });
  }
});

test("Recording restore rejects corrupt bytes and paths outside the evidence directory", async () => {
  const bytes = await fs.readFile(new URL("./assets/recording.json.gz", import.meta.url));
  assert.throws(() => decodeRecording(bytes, "wrong hash"), /checksum mismatch/);
  const data = JSON.parse(gunzipSync(bytes));
  data.files[0].path = ".agent-eval/marketing-video/../../outside";
  const escaped = gzipSync(JSON.stringify(data));
  assert.throws(() => decodeRecording(escaped, hash(escaped)), /Invalid recording path/);
});

test("Drafts, failed renders, changed captions and stale composition cannot replace a valid export", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "aek-release-test-"));
  const expected = {
    cut: "main",
    format: "landscape",
    duration: 60,
    compositionSha256: "composition-a",
    evidenceSha256: "evidence-a",
    workflowSha256: "workflow-a",
  };
  const stage = async (label) => {
    const directory = path.join(output, label);
    await fs.mkdir(path.join(directory, "stills"), { recursive: true });
    for (const name of ["video.mp4", "captions.vtt", "poster.png", "stills/1.png"])
      await fs.writeFile(path.join(directory, name), `${label}:${name}`);
    return directory;
  };
  try {
    const first = await stage("accepted");
    await sealExport(first, expected);
    await publishExport(output, "landscape", first, expected);
    const link = path.join(output, "exports/landscape");
    const draft = await stage("draft");
    await fs.rm(path.join(draft, "video.mp4"));
    await assert.rejects(sealExport(draft, expected), /missing video.mp4/);
    await assert.rejects(publishExport(output, "landscape", draft, expected), /ENOENT/);
    assert.equal(await fs.realpath(link), first);
    const next = await stage("next");
    await sealExport(next, expected);
    for (const asset of ["captions.vtt", "poster.png", "stills/1.png", "video.mp4"]) {
      const original = await fs.readFile(path.join(next, asset));
      await fs.appendFile(path.join(next, asset), "new version");
      await assert.rejects(
        publishExport(output, "landscape", next, expected),
        /Render asset changed/,
      );
      assert.equal(await fs.realpath(link), first);
      await fs.writeFile(path.join(next, asset), original);
    }
    await assert.rejects(
      verifyExport(next, { ...expected, compositionSha256: "composition-b" }),
      /compositionSha256 changed/,
    );
    await publishExport(output, "landscape", next, expected);
    assert.equal(await fs.realpath(link), next);
    for (const asset of ["video.mp4", "captions.vtt", "poster.png"])
      assert.equal(await fs.readFile(path.join(link, asset), "utf8"), `next:${asset}`);
  } finally {
    await fs.rm(output, { recursive: true });
  }
});

test("Composition fingerprints change when story, layout or font inputs change", async () => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "aek-inputs-test-"));
  try {
    for (const file of [
      "video/marketing/src",
      "video/marketing/render.mjs",
      "video/marketing/release.mjs",
      "video/marketing/terrain.mjs",
      "video/marketing/media.mjs",
      "video/marketing/package.json",
      "video/marketing/evidence.mjs",
      "video/marketing/workflow.mjs",
      "video/marketing/improvement/snapshot.mjs",
      "video/marketing/package-lock.json",
      "video/marketing/toolchain.json",
      "video/marketing/assets/InterVariable.woff2",
      "pnpm-lock.yaml",
      "docs/marketing/hill-climbing.svg",
      ".agent-eval/marketing-video/evidence.json",
      ".agent-eval/marketing-video/workflow.json",
    ]) {
      await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
      await fs.cp(path.join(root, file), path.join(destination, file), { recursive: true });
    }
    const before = await renderInputs(destination);
    for (const file of ["src/story.mjs", "src/Video.jsx", "assets/InterVariable.woff2"]) {
      const target = path.join(destination, "video/marketing", file),
        original = await fs.readFile(target);
      await fs.appendFile(target, "changed");
      assert.notEqual(
        (await renderInputs(destination)).compositionSha256,
        before.compositionSha256,
        file,
      );
      await fs.writeFile(target, original);
    }
  } finally {
    await fs.rm(destination, { recursive: true });
  }
});
