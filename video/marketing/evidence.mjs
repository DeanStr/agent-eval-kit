import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { hash } from "./media.mjs";
import { assertEvaluatedSnapshot, assertSessionSnapshots } from "./improvement/snapshot.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".agent-eval/marketing-video");
const readJSON = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
export async function loadEvidence() {
  const manifest = await readJSON(path.join(output, "evidence.json"));
  if (manifest.version !== 2)
    throw Error("Expected dashboard improvement evidence. Capture an actual session first.");
  for (const source of manifest.sources)
    if (hash(await fs.readFile(path.join(root, source.path))) !== source.sha256)
      throw Error(`Evidence changed: ${source.path}`);
  assertSessionSnapshots(root, manifest.session, "dashboard");
  const screenshots = {};
  for (const name of [
    "baselineDesktop",
    "baselineMobile",
    "proportionsDesktop",
    "proportionsMobile",
    "overviewDesktop",
    "overviewMobile",
  ]) {
    if (!manifest.screenshots[name]) throw Error(`Missing capture: ${name}`);
    const bytes = await fs.readFile(path.join(root, manifest.screenshots[name]));
    const { width, height } = await sharp(bytes).metadata();
    screenshots[name] = { src: `data:image/png;base64,${bytes.toString("base64")}`, width, height };
  }
  // Measured phone chart geometry, in the same state as each phone screenshot.
  const phoneRows = {};
  for (const name of ["baseline", "proportions"]) {
    const file = path.join(
      manifest.artifacts[name],
      "DASHBOARD/collector-output/observations.json",
    );
    if (!manifest.sources.some((source) => source.path === file))
      throw Error(`Observations are not sealed: ${file}`);
    phoneRows[name] = (await readJSON(path.join(root, file))).mobileWeekly.rows.map((row) => ({
      region: row.label,
      value: row.value,
      bar: row.barRect,
    }));
  }
  return { ...manifest, screenshots, phoneRows };
}
async function sealSession(sessionArg) {
  if (!sessionArg) throw Error("Usage: node evidence.mjs <completed dashboard session>");
  const session = path.resolve(sessionArg);
  const journal = (await fs.readFile(path.join(session, "journal.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (journal.some((e) => e.executionError || ![0, 2].includes(e.exitCode)))
    throw Error(
      "Session contains an execution failure; resolve and document it before publishing.",
    );
  const results = {},
    artifacts = {},
    screenshots = {},
    sources = [];
  const seal = async (file) => {
    const relative = path.relative(root, file);
    if (relative.startsWith("../")) throw Error("Evidence must remain inside this checkout");
    if (!sources.some((x) => x.path === relative))
      sources.push({ path: relative, sha256: hash(await fs.readFile(file)) });
    return relative;
  };
  const sealTree = async (directory) => {
    for (const e of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, e.name);
      if (e.isDirectory()) await sealTree(file);
      else if (e.isFile()) await seal(file);
      else throw Error(`Unexpected non-file in evidence: ${file}`);
    }
  };
  const aek = (...args) =>
    execFileSync(process.execPath, [path.join(root, "dist/cli.js"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
    });
  for (const name of ["baseline", "proportions", "overview", "repeat"]) {
    const entries = journal.filter((e) => e.label === name);
    if (entries.length !== 1) throw Error(`Need exactly one ${name} evaluation`);
    const entry = entries[0],
      directory = path.join(root, entry.run),
      report = await readJSON(path.join(directory, "report.json"));
    assertEvaluatedSnapshot("dashboard", path.join(root, entry.snapshot), entry.sha256, report);
    aek("verify", "--run", directory);
    results[name] = {
      score: report.overallScorePct,
      coverage: report.overallCoveragePct,
      gate: report.gates.passed,
      fingerprint: report.receipt.evaluationFingerprint,
      runId: report.runId,
      items: Object.fromEntries(
        report.areas.flatMap((a) =>
          a.items.map((i) => [i.id, { verdict: i.verdict, reasoning: i.reasoning }]),
        ),
      ),
    };
    artifacts[name] = entry.run;
    if (name !== "repeat")
      for (const size of ["Desktop", "Mobile"])
        screenshots[name + size] = await seal(
          path.join(directory, "DASHBOARD/screenshots", size.toLowerCase() + ".png"),
        );
    await sealTree(directory);
    await seal(path.join(root, entry.snapshot));
  }
  if (new Set(Object.values(results).map((r) => r.fingerprint)).size !== 1)
    throw Error("Evaluator changed across revisions");
  if (Object.values(results).some((r) => r.coverage !== 100))
    throw Error("This film requires complete observed coverage; do not fill missing results.");
  if (
    results.overview.items.OVERVIEW.verdict !== "pass" ||
    !results.overview.gate ||
    results.repeat.score !== results.overview.score
  )
    throw Error(
      "The final improvement is not established and repeated. Review actual outcomes before scripting.",
    );
  for (const [name, baseline, candidate] of [
    ["first", "baseline", "proportions"],
    ["second", "proportions", "overview"],
    ["comparison", "baseline", "overview"],
  ]) {
    const directory = path.join(session, name);
    aek(
      "compare",
      "--baseline",
      path.join(root, artifacts[baseline]),
      "--candidate",
      path.join(root, artifacts[candidate]),
      "--fail-on-regression",
      "--output",
      directory,
    );
    artifacts[name] = path.relative(root, directory);
    await sealTree(directory);
  }
  const origin = await readJSON(path.join(session, "origin.json"));
  if (hash(await fs.readFile(path.join(session, "baseline.html"))) !== origin.sha256)
    throw Error("Baseline must be the unchanged pre-existing dashboard");
  for (const name of ["origin.json", "journal.ndjson", "original.html"])
    await seal(path.join(session, name));
  const observations = await readJSON(
    path.join(root, artifacts.baseline, "DASHBOARD/collector-output/observations.json"),
  );
  const manifest = {
    version: 2,
    capturedAt: new Date().toISOString(),
    session: path.relative(root, session),
    origin,
    results,
    artifacts,
    screenshots,
    sources,
    baselineBars: observations.mobileWeekly.rows.map((row) => ({
      region: row.label,
      value: row.value,
      width: row.barRect.width,
    })),
    scope:
      "Three project-specific criteria on an existing sample dashboard, using synthetic delivery data. Actual coding-agent revisions, deterministic browser measurements and fresh Codex overview judgments. Edited presentation of retained evidence, not a live screen recording. The repeated final evaluation does not establish general judge accuracy or customer outcomes.",
  };
  await fs.writeFile(path.join(output, "evidence.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ session, results, files: sources.length }, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await sealSession(process.argv[2]);
