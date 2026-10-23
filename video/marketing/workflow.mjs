import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { hash } from "./media.mjs";
import {
  hashTarget,
  assertEvaluatedSnapshot,
  assertSessionSnapshots,
} from "./improvement/snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".agent-eval/marketing-video");
const published = "docs/marketing/dispatch";
const siteFiles = ["index.html", "style.css", "app.js", "data.js", "InterVariable.woff2"];
const readJSON = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const dataUri = async (file) =>
  `data:image/png;base64,${(await fs.readFile(path.join(root, file))).toString("base64")}`;

export async function loadWorkflow() {
  const manifest = await readJSON(path.join(output, "workflow.json"));
  if (manifest.version !== 2)
    throw Error(
      "Capture the measured dispatch workflow: node video/marketing/workflow.mjs <session>",
    );
  for (const source of manifest.sources)
    if (hash(await fs.readFile(path.join(root, source.path))) !== source.sha256)
      throw Error(`Workflow capture changed: ${source.path}`);
  assertSessionSnapshots(root, manifest.evaluation.session, "dispatch");
  // The film, the evaluated final revision and the published prototype must stay identical.
  if (hashTarget(path.join(root, published)) !== manifest.published.sha256)
    throw Error(
      `${published} differs from the evaluated and captured revision. Evaluate it, then re-run workflow.mjs.`,
    );
  const screenshots = {};
  for (const [name, shot] of Object.entries(manifest.screenshots))
    screenshots[name] = { ...shot, src: await dataUri(shot.path) };
  return { ...manifest, screenshots };
}

const aek = (...args) =>
  execFileSync(process.execPath, [path.join(root, "dist/cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
  });

async function capture(sessionArg) {
  if (!sessionArg) throw Error("Usage: node workflow.mjs <completed dispatch session>");
  const evaluated = path.resolve(sessionArg);
  await fs.mkdir(output, { recursive: true });
  const session = await fs.mkdtemp(path.join(output, "workflow-"));
  const sources = [];
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

  // Seal the dispatch evaluation session first; capture nothing unless it is complete.
  const origin = await readJSON(path.join(evaluated, "origin.json"));
  if (origin.kind !== "dispatch") throw Error("Expected a dispatch improvement session");
  const journal = (await fs.readFile(path.join(evaluated, "journal.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const labels = journal.map((e) => e.label);
  if (
    new Set(labels).size !== labels.length ||
    labels[0] !== "baseline" ||
    labels.at(-1) !== "repeat"
  )
    throw Error("Expected one baseline, at least one revision, then one repeat evaluation");
  if (labels.length < 3) throw Error("Expected at least one evaluated revision");
  if (journal.some((e) => e.executionError || ![0, 2].includes(e.exitCode)))
    throw Error(
      "Session contains an execution failure; resolve and document it before publishing.",
    );
  if (
    hashTarget(path.join(evaluated, "original")) !== origin.sha256 ||
    journal[0].sha256 !== origin.sha256
  )
    throw Error("Baseline must be the unchanged human-directed prototype");
  const results = [];
  for (const entry of journal) {
    const directory = path.join(root, entry.run),
      report = await readJSON(path.join(directory, "report.json"));
    assertEvaluatedSnapshot("dispatch", path.join(root, entry.snapshot), entry.sha256, report);
    aek("verify", "--run", directory);
    results.push({
      label: entry.label,
      rationale: entry.rationale,
      sha256: entry.sha256,
      run: entry.run,
      runId: report.runId,
      score: report.overallScorePct,
      coverage: report.overallCoveragePct,
      gate: report.gates.passed,
      fingerprint: report.receipt.evaluationFingerprint,
      items: Object.fromEntries(
        report.areas.flatMap((a) =>
          a.items.map((i) => [i.id, { verdict: i.verdict, reasoning: i.reasoning }]),
        ),
      ),
    });
    await sealTree(directory);
    await sealTree(path.join(root, entry.snapshot));
  }
  if (new Set(results.map((r) => r.fingerprint)).size !== 1)
    throw Error("Evaluator changed across revisions");
  if (results.some((r) => r.coverage !== 100))
    throw Error("This film requires complete observed coverage; do not fill missing results.");
  const [baseline, final, repeat] = [results[0], results.at(-2), results.at(-1)];
  if (
    repeat.sha256 !== final.sha256 ||
    repeat.score !== final.score ||
    !final.gate ||
    Object.values(final.items).some((item) => item.verdict !== "pass") ||
    !(final.score > baseline.score)
  )
    throw Error("The final dispatch improvement is not established and repeated.");
  // Comparisons live beside the evaluated runs (../../runs/<id>), like the dashboard's.
  const comparisons = {};
  const compared = path.join(evaluated, path.basename(session));
  for (const [name, from, to] of [
    ...results.slice(1, -1).map((r, i) => [r.label, results[i], r]),
    ["overall", baseline, final],
  ]) {
    const directory = path.join(compared, `compare-${name}`);
    aek(
      "compare",
      "--baseline",
      path.join(root, from.run),
      "--candidate",
      path.join(root, to.run),
      "--fail-on-regression",
      "--output",
      directory,
    );
    comparisons[name] = path.relative(root, directory);
    await sealTree(directory);
  }
  for (const name of ["origin.json", "journal.ndjson"]) await seal(path.join(evaluated, name));
  await sealTree(path.join(evaluated, "original"));
  const publishedSha = hashTarget(path.join(root, published));
  if (publishedSha !== final.sha256)
    throw Error(`Publish the final evaluated revision to ${published} before capturing.`);

  // Capture the published revision, plus the baseline queue for the phone finding.
  const site = path.join(session, "site");
  await fs.mkdir(site);
  for (const name of siteFiles)
    await fs.copyFile(path.join(root, published, name), path.join(site, name));
  for (const name of siteFiles) await seal(path.join(site, name));
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
  };
  const serve = async (directory) => {
    const server = http.createServer(async (request, response) => {
      const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
      if (!siteFiles.includes(name)) return response.writeHead(404).end();
      response
        .writeHead(200, { "content-type": mime[path.extname(name)] })
        .end(await fs.readFile(path.join(directory, name)));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  };
  const servers = {
    final: await serve(site),
    baseline: await serve(path.join(root, journal[0].snapshot)),
    revision: await serve(path.join(root, journal[1].snapshot)),
  };
  const screenshots = {},
    observations = {};
  let facts;
  const browser = await chromium.launch();
  try {
    const open = async (size, which) => {
      const scale = size === "mobile" ? 3 : 2;
      const viewport =
        size === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1120 };
      const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(servers[which].url);
      await page.evaluate(() => document.fonts.ready);
      return { context, page, errors, scale };
    };
    // Regions are CSS-pixel boxes relative to the captured element, for framing and highlights.
    const shot = async ({ page, scale }, name, target, regions = {}) => {
      const file = path.join(session, `${name}.png`);
      const fullPage = target === "page";
      const origin = fullPage
        ? { x: 0, y: 0 }
        : await page.locator(target).evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + scrollX, y: r.y + scrollY };
          });
      if (fullPage) await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      else await page.locator(target).screenshot({ path: file, animations: "disabled" });
      const boxes = {};
      for (const [region, selector] of Object.entries(regions))
        boxes[region] = await page
          .locator(selector)
          .first()
          .evaluate((el, o) => {
            const r = el.getBoundingClientRect();
            return {
              x: r.x + scrollX - o.x,
              y: r.y + scrollY - o.y,
              width: r.width,
              height: r.height,
            };
          }, origin);
      const metadata = await sharp(file).metadata();
      screenshots[name] = {
        path: await seal(file),
        width: metadata.width / scale,
        height: metadata.height / scale,
        pixelWidth: metadata.width,
        pixelHeight: metadata.height,
        scale,
        regions: boxes,
      };
    };
    const workspaceRegions = {
      risk: ".attention-metric",
      row: '[data-shipment="RL-2048"]',
      detail: "#detail",
      arrival: "#detail .arrival-strip",
      map: ".map",
    };
    const dialogRegions = {
      chosen: '.option:has(input[value="leo"])',
      rejected: '.option:has(input[value="nina"])',
      reason: '.option:has(input[value="nina"]) .option-warning',
      plan: ".plan",
      confirm: "#confirm-reassignment",
    };
    for (const size of ["desktop", "mobile"]) {
      const view = await open(size, "final");
      const { page, errors, context } = view;
      if (size === "desktop") await shot(view, "desktopWorkspace", "main", workspaceRegions);
      else await shot(view, "mobileWorkspace", "page", { ...workspaceRegions, queue: ".queue" });
      observations[`${size}Before`] = await page.locator("#detail").innerText();
      assert.match(observations[`${size}Before`], /14:52/);
      if (size === "desktop") facts = { shipment: await page.evaluate(readShipment) };
      await page.locator("#find-recovery").click();
      assert.equal(await page.getByRole("radio", { name: /Nina Patel/ }).isDisabled(), true);
      await shot(view, `${size}Dialog`, "#recovery", dialogRegions);
      observations[`${size}Choices`] = await page.locator("#recovery").innerText();
      if (size === "desktop") facts.options = await page.evaluate(readOptions);
      await page.locator("#confirm-reassignment").click();
      assert.equal(await page.locator("#risk-count").textContent(), "0");
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      observations[`${size}After`] = await page.locator("#detail").innerText();
      assert.match(observations[`${size}After`], /Leo Chen/);
      assert.match(observations[`${size}After`], /14:18/);
      assert.equal(await page.locator(".delivery").count(), 9);
      if (size === "desktop") {
        facts.after = { ...(await page.evaluate(readShipment)), atRisk: 0 };
        await shot(view, "desktopAfter", "main", {
          ...workspaceRegions,
          undo: "#undo-detail",
          recovered: "#detail .cause",
        });
      } else
        await shot(view, "mobileAfter", "#detail", {
          arrival: "#detail .arrival-strip",
          recovered: "#detail .cause",
          undo: "#undo-detail",
        });
      await page.locator("#undo-detail").click();
      assert.equal(await page.locator("#risk-count").textContent(), "1");
      assert.deepEqual(errors, []);
      observations[`${size}Checks`] = {
        reassignment: true,
        persistedAfterReload: true,
        undo: true,
        shipmentCount: 9,
        errors,
      };
      await context.close();
    }
    const baselineView = await open("desktop", "baseline");
    await shot(baselineView, "desktopBaseline", "main", workspaceRegions);
    assert.deepEqual(baselineView.errors, []);
    await baselineView.context.close();
    for (const which of ["baseline", "revision", "final"]) {
      const view = await open("mobile", which);
      await shot(view, `mobileQueue${which[0].toUpperCase() + which.slice(1)}`, ".queue", {
        rows: "#shipments",
      });
      assert.deepEqual(view.errors, []);
      await view.context.close();
    }
  } finally {
    await browser.close();
    for (const { server } of Object.values(servers))
      await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(facts.shipment.eta, "14:52");
  assert.equal(facts.after.eta, "14:18");
  assert.equal(facts.options.find((o) => !o.eligible)?.name, "Nina Patel");
  await fs.writeFile(
    path.join(session, "observations.json"),
    JSON.stringify({ ...observations, facts }, null, 2),
  );
  await seal(path.join(session, "observations.json"));
  const manifest = {
    version: 2,
    capturedAt: new Date().toISOString(),
    session: path.relative(root, session),
    published: { path: published, sha256: publishedSha },
    evaluation: {
      session: path.relative(root, evaluated),
      origin,
      results,
      comparisons,
    },
    sources,
    screenshots,
    observations,
    facts,
    scope:
      "Human feedback directed this dispatch prototype; a separate frozen AEK suite then evaluated it and guided two coding-agent revisions. Synthetic dispatch records and fixed route estimates. Actual browser captures of the evaluated final revision; reassignment, persistence and undo checked in the browser. The earlier dashboard verdicts do not score this workflow. Edited still sequence, not continuous screen recording.",
  };
  await fs.writeFile(path.join(output, "workflow.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        session,
        evaluation: results.map((r) => `${r.label} ${r.score}%`),
        screenshots: Object.keys(screenshots),
        files: sources.length,
      },
      null,
      2,
    ),
  );
}

// Read in the page: the selected shipment as the interface presents it.
function readShipment() {
  const detail = document.querySelector("#detail");
  const own = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("")
      .trim();
  const [arrival, deadline] = detail.querySelectorAll(".arrival-strip strong");
  const cause = detail.querySelector(".cause > div");
  return {
    id: detail.querySelector(".eyebrow").textContent.trim(),
    name: detail.querySelector("h2").textContent.trim(),
    eta: own(arrival),
    timing: arrival.querySelector("small")?.textContent.trim() ?? null,
    due: own(deadline),
    cause: cause ? own(cause) : null,
    driver: own(detail.querySelector(".assigned > div")),
  };
}
function readOptions() {
  return [...document.querySelectorAll("#recovery .option")].map((option) => ({
    name: option.querySelector("strong").textContent.trim(),
    eta: option.querySelector(".option-eta b").textContent.trim(),
    eligible: !option.querySelector("input").disabled,
    vehicle: option.querySelector(".option-details span:last-child").textContent.trim(),
    reason: option.querySelector(".option-warning")?.textContent.trim() ?? null,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await capture(process.argv[2]);
