import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { buildRunReceipt } from "../src/receipts.js";
import { writeHtml } from "../src/report.js";
import { buildReport, scoreArea } from "../src/scoring.js";
import { loadSpecs } from "../src/specs.js";
import type { JudgedItem, ScenarioEvidence, Verdict } from "../src/types.js";

test("report filters use evidence-backed verdicts and retain pending manual work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-report-filters-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    "version: 1\nproject: { name: Filters }\ntarget: { kind: repository }\nagent: { provider: mock }\njudge: { provider: mock }\npaths: { specs: spec.yaml }\n",
  );
  const config = loadConfig(configFile);
  const judgements: JudgedItem[] = [];
  const rubric = [];
  for (const outcome of ["blocked", "completed"] as const) {
    for (const verdict of [
      "pass",
      "fail",
      "not_found",
      "partial",
      "cannot_judge",
    ] satisfies Verdict[]) {
      const id = `${outcome}-${verdict}`;
      rubric.push({ id, criterion: id, weight: 1, passCriteria: "Observed", scenarios: [outcome] });
      judgements.push({
        id,
        verdict,
        confidence: "high",
        reasoning: "Original judgement",
        evidenceRefs: [],
        source: "llm",
      });
    }
  }
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    YAML.stringify({
      id: "core",
      title: "Core",
      weight: 100,
      description: "Filter coverage",
      scenarios: ["blocked", "completed"].map((id) => ({ id, name: id, instructions: "Inspect" })),
      rubric: [
        ...rubric,
        {
          id: "manual",
          criterion: "Manual",
          weight: 1,
          passCriteria: "Observed",
          grader: { type: "manual" },
          manualInstructions: "Inspect",
        },
        {
          id: "hybrid",
          criterion: "Hybrid",
          weight: 1,
          passCriteria: "Observed",
          scenarios: ["blocked"],
          grader: { type: "hybrid", autoShare: 0.5 },
          manualInstructions: "Inspect",
        },
      ],
    }),
  );
  const [spec] = loadSpecs(config.paths.specs);
  assert.ok(spec);
  const evidence: ScenarioEvidence[] = (["blocked", "completed"] as const).map((id) => ({
    scenarioId: id,
    scenarioName: id,
    kind: "workspace",
    outcome: id,
    summary: id,
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
  }));
  judgements.push({
    id: "hybrid",
    verdict: "fail",
    components: { automatic: "fail", manual: "pass" },
    confidence: "high",
    reasoning: "Manual share verified",
    evidenceRefs: [],
    source: "manual",
  });
  const area = scoreArea({ config, spec, evidence, judgements });
  assert.deepEqual(area.unproven, [
    "blocked-pass",
    "blocked-fail",
    "blocked-not_found",
    "blocked-partial",
    "hybrid",
  ]);
  assert.equal(area.items.find((item) => item.id === "hybrid")?.score?.coveragePct, 50);
  const report = buildReport({
    runId: "filters",
    startedAt: evidence[0]!.startedAt,
    config,
    areas: [area],
    receipt: buildRunReceipt({ config, specs: [spec], fixtures: {} }),
  });
  const originalReport = JSON.stringify(report);
  writeHtml(root, report, [spec]);
  assert.equal(
    JSON.stringify(report),
    originalReport,
    "Rendering preserves recorded judgements and scores",
  );
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(root, "report.html")).href);
  const rows = page.locator("tr[data-result]");
  const visibleIds = () =>
    page.locator("tr[data-result]:visible > td:first-child > code").allTextContents();
  const missing = [
    "blocked-pass",
    "blocked-fail",
    "blocked-not_found",
    "blocked-partial",
    "blocked-cannot_judge",
    "completed-cannot_judge",
    "hybrid",
  ];
  const allIds = [...judgements.map((item) => item.id), "manual"];
  for (const [filter, expected] of [
    ["action", allIds.filter((id) => id !== "completed-pass")],
    ["failed", ["completed-fail", "completed-not_found"]],
    ["missing", missing],
    ["pending", ["manual"]],
    ["all", allIds],
  ] as const) {
    await page.selectOption("#review-filter", filter);
    assert.deepEqual(await visibleIds(), expected, filter);
    assert.equal(
      await page.locator("#review-count").textContent(),
      `${expected.length} of ${allIds.length} criteria shown`,
    );
  }
  for (const id of area.unproven) {
    const row = rows.filter({ has: page.locator("td:first-child > code", { hasText: id }) });
    assert.match(await row.locator("td").nth(1).innerText(), /^cannot_judge/);
    assert.match(await row.innerText(), /Automatic verdict discarded/);
  }
  assert.match(
    await rows.filter({ hasText: "Manual share verified" }).innerText(),
    /Manual verdict retained: pass/,
  );
});
