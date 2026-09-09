import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { sha256, stableJson } from "../src/io.js";
import { judgeArea } from "../src/graders.js";
import {
  aggregateCaseVerdicts,
  constrainFullPass,
  requiredJudgeResult,
} from "../src/judging/contracts.js";
import { assertPairInspection } from "../src/visual/pairwise.js";
import { assertScreenshotAccess } from "../src/evidence/inspection.js";
import type { EvalConfig, EvalSpec, ScenarioEvidence, Verdict } from "../src/types.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-contract-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config: EvalConfig = {
    version: 1,
    project: { name: "Contracts", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root, references: path.join(root, "text-references") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Contracts",
    sourceFile: path.join(root, "unused.yaml"),
    scenarios: [],
    rubric: [
      {
        id: "R",
        criterion: "Legible",
        weight: 1,
        tags: [],
        scenarios: ["S"],
        grader: { type: "llm" },
        passCriteria: "Legible",
      },
    ],
  };
  const evidence: ScenarioEvidence = {
    scenarioId: "S",
    scenarioName: "Inspect",
    kind: "browser",
    outcome: "completed",
    summary: "Captured",
    observations: ["Text evidence"],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-09-05T00:00:00Z",
    finishedAt: "2026-09-05T00:00:01Z",
    durationMs: 1_000,
  };
  const answer = (ref = "S/evidence.json", verdict = "pass") => ({
    items: [{ id: "R", verdict, confidence: "high", reasoning: "Observed", evidenceRefs: [ref] }],
    cases: [
      {
        rubricId: "R",
        caseId: "default",
        verdict,
        confidence: "high",
        reasoning: "Observed",
        evidenceRefs: [ref],
      },
    ],
    defects: [] as Array<{ severity: string; description: string; evidenceRefs: string[] }>,
    notes: "",
  });
  const fake = (structured: unknown, transcript?: string) => {
    const script = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const mcpIndex = args.indexOf('--mcp-config');
if (mcpIndex >= 0 && ${transcript !== undefined}) {
  const mcp = JSON.parse(fs.readFileSync(args[mcpIndex + 1], 'utf8')).mcpServers.evidence;
  const context = JSON.parse(fs.readFileSync(mcp.args.at(-1), 'utf8'));
  fs.writeFileSync(context.transcriptFile, ${JSON.stringify(transcript ?? "")});
}
const structured = ${JSON.stringify(structured)};
if (path.basename(process.argv[1]) === 'codex') {
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(structured));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(structured)}}));
} else console.log(JSON.stringify({type:'result',structured_output:structured,result:JSON.stringify(structured)}));
`;
    for (const name of ["claude", "codex"])
      fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  };
  const screenshot = (name: string) => {
    const relative = `screenshots/${name}.png`;
    fs.mkdirSync(path.join(root, "S", "screenshots"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "S", relative),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    evidence.screenshots.push({
      path: relative,
      label: name,
      step: evidence.screenshots.length + 1,
    });
    return `S/${relative}`;
  };
  const evidenceList = [evidence];
  const grade = (name: string) =>
    judgeArea({
      commands: { mode: "execute" },
      config,
      spec,
      evidence: evidenceList,
      runDir: root,
      areaDirectory: path.join(root, name),
    });
  return { root, config, spec, evidence: evidenceList, answer, fake, screenshot, grade };
}

const view = (reference: string, isError = false) =>
  JSON.stringify({
    at: "2026-09-05T00:00:00Z",
    tool: "view_screenshot",
    reference,
    result: "Response",
    isError,
  }) + "\n";

test("PNG attachments use IHDR dimensions, not embedded JPEG-like markers", async (t) => {
  const f = fixture(t);
  f.config.judge.provider = "codex";
  const ref = f.screenshot("png-markers");
  const file = path.join(f.root, ref);
  const png = fs.readFileSync(file);
  // A valid ancillary tEXt chunk contains bytes resembling a JPEG SOF marker
  // with 5,000px dimensions. They must never override the PNG's 1×1 IHDR.
  const data = Buffer.concat([
    Buffer.from("Comment\0"),
    Buffer.from([0xff, 0xc0, 0, 8, 8, 0x13, 0x88, 0x13, 0x88]),
  ]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  fs.writeFileSync(file, Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]));
  assert.equal((await sharp(file).metadata()).width, 1);
  f.fake(f.answer(ref));
  assert.equal((await f.grade("png-attached")).items[0]?.verdict, "pass");

  await sharp({ create: { width: 2001, height: 1, channels: 3, background: "white" } })
    .png()
    .toFile(file);
  await assert.rejects(f.grade("oversize-png"), /screenshot contract violation/);
});

test("judge output requires exactly the requested rubric and case identities", async (t) => {
  const f = fixture(t);
  for (const [name, mutate, expected] of [
    [
      "missing-item",
      (a: ReturnType<typeof f.answer>) => {
        a.items = [];
      },
      /missing rubric item IDs \(R\)/,
    ],
    [
      "missing-case",
      (a: ReturnType<typeof f.answer>) => {
        a.cases = [];
      },
      /missing case identities \(R\/default\)/,
    ],
    [
      "extra-item",
      (a: ReturnType<typeof f.answer>) => {
        a.items.push({ ...requireDefined(a.items[0], "a.items[0]"), id: "OTHER" });
      },
      /unexpected rubric item IDs \(OTHER\)/,
    ],
    [
      "extra-case",
      (a: ReturnType<typeof f.answer>) => {
        a.cases.push({ ...requireDefined(a.cases[0], "a.cases[0]"), caseId: "other" });
      },
      /unexpected case identities \(R\/other\)/,
    ],
  ] as const) {
    const answer = f.answer();
    mutate(answer);
    f.fake(answer);
    await assert.rejects(f.grade(name), expected);
    assert.ok(
      fs.existsSync(path.join(f.root, name, "_judge", "provider-run.json")),
      "retain diagnostics",
    );
  }
  f.fake(f.answer("S/evidence.json", "cannot_judge"));
  assert.equal(
    requireDefined((await f.grade("abstain")).items[0], '(await f.grade("abstain")).items[0]')
      .verdict,
    "cannot_judge",
  );
});

test("ordinary screenshot claims require successful views, including case and defect citations", async (t) => {
  const f = fixture(t),
    ref = f.screenshot("result");
  for (const [name, transcript, expected] of [
    ["missing", undefined, /screenshot contract violation/],
    ["failed", view(ref, true), /screenshot contract violation/],
    ["wrong", view("S/screenshots/other.png"), /screenshot contract violation/],
    ["malformed", "{\n", /Invalid image-view transcript JSON/],
    [
      "invalid",
      '{"reference":"S/screenshots/result.png"}\n',
      /Invalid image-view transcript record/,
    ],
  ] as const) {
    f.fake(f.answer(ref), transcript);
    await assert.rejects(f.grade(name), expected);
  }
  const caseOnly = f.answer();
  requireDefined(caseOnly.cases[0], "caseOnly.cases[0]").evidenceRefs = [ref];
  f.fake(caseOnly);
  await assert.rejects(f.grade("case-only"), /screenshot contract violation/);
  const defectOnly = f.answer();
  defectOnly.defects.push({ severity: "major", description: "Unreadable", evidenceRefs: [ref] });
  f.fake(defectOnly);
  await assert.rejects(f.grade("defect-only"), /screenshot contract violation/);
  f.fake(f.answer(ref), view(ref, true) + view(ref));
  assert.equal(
    requireDefined((await f.grade("viewed")).items[0], '(await f.grade("viewed")).items[0]')
      .verdict,
    "pass",
  );
  f.fake(f.answer(ref, "cannot_judge"));
  assert.equal(
    requireDefined((await f.grade("abstain")).items[0], '(await f.grade("abstain")).items[0]')
      .verdict,
    "cannot_judge",
  );
  f.fake(f.answer());
  assert.equal(
    requireDefined((await f.grade("text-only")).items[0], '(await f.grade("text-only")).items[0]')
      .verdict,
    "pass",
  );
});

test("attached Codex images count as accessed but images outside the attachment budget do not", async (t) => {
  const f = fixture(t),
    excluded = f.screenshot("first");
  f.config.judge.provider = "codex";
  f.fake(f.answer(excluded));
  assert.equal(
    requireDefined((await f.grade("attached")).items[0], '(await f.grade("attached")).items[0]')
      .verdict,
    "pass",
  );
  for (let i = 0; i < 30; i++) f.screenshot(`later-${i}`);
  f.fake(f.answer(excluded));
  await assert.rejects(f.grade("excluded"), /screenshot contract violation/);
});

test("invalid repeated judgements are not journaled and can be retried with explicit valid results", async (t) => {
  const f = fixture(t),
    ref = f.screenshot("result");
  f.config.judge.voting = { minimumVotes: 1, maximumVotes: 1, agreement: 1, minimumConfidence: 0 };
  fs.writeFileSync(
    path.join(f.root, "receipt.json"),
    JSON.stringify({ evaluationFingerprint: "fixed" }),
  );
  const vote = path.join(f.root, "repeated", "_judge", "votes", "vote-01", "vote.json");
  f.fake({ items: [], cases: [], defects: [], notes: "" });
  await assert.rejects(f.grade("repeated"), /missing rubric/);
  assert.equal(fs.existsSync(vote), false);
  f.fake(f.answer(ref));
  await assert.rejects(f.grade("repeated"), /screenshot contract violation/);
  assert.equal(fs.existsSync(vote), false);
  f.fake(f.answer(ref), view(ref));
  assert.equal(
    requireDefined((await f.grade("repeated")).items[0], '(await f.grade("repeated")).items[0]')
      .verdict,
    "pass",
  );
  assert.ok(fs.existsSync(vote));
  f.fake({ items: [], cases: [], defects: [], notes: "" });
  assert.equal(
    requireDefined((await f.grade("repeated")).items[0], '(await f.grade("repeated")).items[0]')
      .verdict,
    "pass",
    "reuse sealed valid vote",
  );
  const saved = JSON.parse(fs.readFileSync(vote, "utf8"));
  saved.result.cases = [];
  saved.resultSha256 = sha256(stableJson(saved.result));
  fs.writeFileSync(vote, JSON.stringify(saved));
  await assert.rejects(
    f.grade("repeated"),
    /missing case identities/,
    "saved result identities must also match the request",
  );
});

test("single and repeated rubric judges share case aggregation, including unavailable evidence", async (t) => {
  const f = fixture(t);
  requireDefined(f.evidence[0], "f.evidence[0]").caseId = "a";
  f.evidence.push({
    ...requireDefined(f.evidence[0], "f.evidence[0]"),
    scenarioId: "OTHER",
    caseId: "b",
  });
  requireDefined(f.spec.rubric[0], "f.spec.rubric[0]").scenarios = ["S", "OTHER"];
  fs.writeFileSync(
    path.join(f.root, "receipt.json"),
    JSON.stringify({ evaluationFingerprint: "fixed" }),
  );
  const outcomes: Array<{ values: Verdict[]; expected: Verdict }> = [
    { values: ["pass", "pass"], expected: "pass" },
    { values: ["pass", "fail"], expected: "partial" },
    { values: ["fail", "not_found"], expected: "fail" },
    { values: ["partial", "partial"], expected: "partial" },
    { values: ["fail", "cannot_judge"], expected: "cannot_judge" },
    { values: ["pass", "cannot_judge"], expected: "cannot_judge" },
  ];
  for (const [index, { values, expected }] of outcomes.entries()) {
    const answer = f.answer();
    answer.cases = f.evidence.map((evidence, i) => ({
      ...requireDefined(answer.cases[0], "answer.cases[0]"),
      caseId: evidence.caseId!,
      verdict: requireDefined(values[i], `verdict ${i}`),
      evidenceRefs: [`${evidence.scenarioId}/evidence.json`],
    }));
    f.fake(answer);
    for (const repeated of [false, true]) {
      if (repeated)
        f.config.judge.voting = {
          minimumVotes: 1,
          maximumVotes: 1,
          agreement: 1,
          minimumConfidence: 0,
        };
      else delete f.config.judge.voting;
      const result = await f.grade(`${index}-${repeated}`);
      assert.equal(
        requireDefined(result.items[0], "result.items[0]").verdict,
        expected,
        `values=${values}, repeated=${repeated}`,
      );
      assert.deepEqual(
        result.cases.map((item) => item.verdict),
        values,
      );
    }
    assert.equal(
      aggregateCaseVerdicts(values),
      expected,
      "pairwise derivation shares all-member semantics",
    );
  }
  assert.equal(aggregateCaseVerdicts([]), "cannot_judge");
  for (const proposed of ["partial", "fail", "not_found", "cannot_judge"] as const) {
    assert.equal(
      constrainFullPass(proposed, ["pass", "pass"]),
      proposed,
      "cases cannot upgrade an independently judged non-pass",
    );
  }
});

test("single and repeated judges reject invalid citations and identities", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "receipt.json"),
    JSON.stringify({ evaluationFingerprint: "fixed" }),
  );
  for (const repeated of [false, true]) {
    if (repeated)
      f.config.judge.voting = {
        minimumVotes: 1,
        maximumVotes: 1,
        agreement: 1,
        minimumConfidence: 0,
      };
    else delete f.config.judge.voting;
    f.fake(f.answer("OTHER/evidence.json"));
    await assert.rejects(
      f.grade(`unknown-citation-${repeated}`),
      /rubric item R.*OTHER\/evidence.json/,
    );
    f.fake({ ...f.answer(), cases: [] });
    await assert.rejects(f.grade(`missing-case-${repeated}`), /missing case identities/);
    const answer = f.answer();
    answer.items.push(requireDefined(answer.items[0], "answer.items[0]"));
    f.fake(answer);
    await assert.rejects(f.grade(`duplicate-${repeated}`), /duplicate rubric item IDs/);
  }
});

test("rubric citations and pairwise decisions share image access rules with different required sets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-shared-views-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rubric = () =>
    assertScreenshotAccess({
      directory: root,
      access: "mcp",
      selectedRefs: ["A", "B"],
      requiredRefs: ["A"],
      context: "Judge screenshot",
    });
  assert.throws(rubric, /missing A/);
  assert.throws(() => assertPairInspection(root, "A"), /missing A, B/);
  fs.writeFileSync(path.join(root, "evidence-transcript.ndjson"), view("A") + view("B", true));
  assert.doesNotThrow(rubric);
  assert.throws(() => assertPairInspection(root, "A"), /missing B/);
  fs.appendFileSync(path.join(root, "evidence-transcript.ndjson"), view("B"));
  assert.doesNotThrow(() => assertPairInspection(root, "equivalent"));
  assert.doesNotThrow(() => assertPairInspection(root, "abstain"));
});

test("a fresh ordinary judge cannot reuse image access from a previous invocation", async (t) => {
  const f = fixture(t),
    ref = f.screenshot("result");
  f.fake(f.answer(ref), view(ref));
  assert.equal(
    requireDefined((await f.grade("retry")).items[0], '(await f.grade("retry")).items[0]').verdict,
    "pass",
  );
  // A later grader can fail after sealing this directory. Resuming the area
  // invokes a new ordinary judge in the same directory with a fresh context.
  f.fake(f.answer(ref));
  await assert.rejects(f.grade("retry"), /screenshot contract violation/);
  f.fake(f.answer(ref), view(ref));
  assert.equal(
    requireDefined((await f.grade("retry")).items[0], '(await f.grade("retry")).items[0]').verdict,
    "pass",
  );
});

test("citation errors fail single and repeated judges without discarding malformed claims", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "receipt.json"),
    JSON.stringify({ evaluationFingerprint: "fixed" }),
  );
  for (const repeated of [false, true]) {
    if (repeated)
      f.config.judge.voting = {
        minimumVotes: 1,
        maximumVotes: 1,
        agreement: 1,
        minimumConfidence: 0,
      };
    else delete f.config.judge.voting;
    for (const target of ["item", "case", "defect"] as const) {
      for (const refs of [[], ["S/evidence.json", "UNKNOWN/evidence.json"]]) {
        const answer = f.answer();
        if (target === "defect")
          answer.defects.push({ severity: "major", description: "Broken", evidenceRefs: refs });
        else
          requireDefined(
            target === "item" ? answer.items[0] : answer.cases[0],
            "judgement target",
          ).evidenceRefs = refs;
        f.fake(answer);
        const directory = `citations-${repeated}-${target}-${refs.length}`;
        await assert.rejects(
          f.grade(directory),
          (error) =>
            error instanceof Error &&
            error.message.includes(
              target === "item"
                ? "rubric item R"
                : target === "case"
                  ? "case R/default"
                  : "defect 1 (Broken)",
            ) &&
            error.message.includes(
              refs.length ? "UNKNOWN/evidence.json" : "no evidence references",
            ),
        );
        assert.equal(
          fs.existsSync(path.join(f.root, directory, "_judge", "votes", "vote-01", "vote.json")),
          false,
        );
      }
    }
    const answer = f.answer("S/evidence.json", "cannot_judge");
    requireDefined(answer.items[0], "answer.items[0]").evidenceRefs = [];
    requireDefined(answer.cases[0], "answer.cases[0]").evidenceRefs = [];
    f.fake(answer);
    const result = await f.grade(`empty-abstention-${repeated}`);
    assert.equal(requireDefined(result.items[0], "result.items[0]").verdict, "cannot_judge");
    assert.equal(requireDefined(result.cases[0], "result.cases[0]").verdict, "cannot_judge");
  }
});

test("missing aggregation results are execution errors while explicit uncertainty is preserved", () => {
  assert.throws(
    () => requiredJudgeResult(undefined, "pairwise scenario S for case R/a"),
    /missing pairwise scenario S for case R\/a/,
  );
  assert.throws(() => requiredJudgeResult(undefined, "rubric item R"), /missing rubric item R/);
  assert.equal(
    requiredJudgeResult({ verdict: "cannot_judge" }, "case R/a").verdict,
    "cannot_judge",
  );
});
