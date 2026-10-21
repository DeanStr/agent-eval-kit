import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertArtifactIntegrity } from "../../dist/integrity.js";
import { loadJudgeValidationReview } from "../../dist/judge-validation-review.js";
import { validationDatasetSchema } from "../../dist/judge-validation.js";
import { sha256, stableJson } from "../../dist/io.js";
import { escapeHtml, reportDocument } from "../../dist/report-presentation.js";

const [command, destination, ...flags] = process.argv.slice(2);
const usage =
  "Usage: node examples/judge-validation/pilot.mjs prepare NEW_DIRECTORY [--judge codex|mock] [--model MODEL] | compare DIRECTORY | summarize DIRECTORY";
if (!["prepare", "compare", "summarize"].includes(command) || !destination) throw new Error(usage);
if (command !== "prepare" && flags.length) throw new Error(usage);
const root = path.resolve(destination);
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const preparedFiles = [
  "labels.agent.json",
  "configurations.json",
  "project/judge-medium.yaml",
  "project/judge-high.yaml",
  "project/specs/browser.yaml",
  "project/specs/file.yaml",
  "project/specs/text.yaml",
];
// Exclude reviewer-source hashes so the metadata can itself be a pinned source.
const caseIdentityHash = (dataset) =>
  sha256(stableJson(dataset.cases.map(({ sources, ...identity }) => identity)));

function loadPilot(dataset) {
  const bytes = fs.readFileSync(path.join(root, "pilot.json"));
  for (const item of dataset.cases) {
    const expected = item.sources.find((source) => source.path === "pilot.json");
    if (!expected || expected.sha256 !== sha256(bytes))
      throw new Error(
        "Pilot metadata is missing or changed from the pinned comparison inputs; start a new pilot",
      );
  }
  const pilot = JSON.parse(bytes.toString("utf8"));
  if (
    !pilot.inputs ||
    stableJson(Object.keys(pilot.inputs).sort()) !== stableJson([...preparedFiles].sort()) ||
    !Object.values(pilot.inputs).every((value) => /^[a-f0-9]{64}$/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(pilot.caseIdentitySha256 ?? "")
  )
    throw new Error("Pilot preparation pins are missing or invalid; prepare a new pilot");
  if (pilot.caseIdentitySha256 !== caseIdentityHash(dataset))
    throw new Error("Prepared pilot case identities changed; prepare a new pilot");
  return pilot;
}

function assertPreparedInput(pilot, file, actual) {
  if (pilot.inputs[file] !== actual)
    throw new Error(`Prepared pilot input changed: ${file}; prepare a new pilot`);
}
const aek = (args, directory, expectedExit = 0) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== expectedExit)
    throw new Error(
      `aek ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
};
const criteria = {
  browser: {
    criterion: "A buyer's changed cart quantity and subtotal survive reload.",
    passCriteria:
      "After setting quantity to two for a 500-cent item and reloading, the visible quantity remains two and subtotal remains 1000 cents. Require before/after runtime evidence. Equivalent labels are acceptable. Source inspection alone cannot establish persistence.",
  },
  file: {
    criterion: "The exported invoice preserves line quantity and computes its subtotal.",
    passCriteria:
      "The executed exporter emits JSON with one Notebook line, quantity two, unit price 1250 cents, and subtotalCents 2500. Extra metadata and property order are irrelevant. Require the actual exported output; source code alone cannot establish execution.",
  },
  text: {
    criterion: "The response states the refund window supported by the supplied policy.",
    passCriteria:
      "The response must state the policy's refund deadline without contradicting it. Equivalent wording is acceptable. A contradictory deadline fails. If the supplied policy does not establish a deadline, abstain rather than guessing from the response or external knowledge.",
  },
};

function prepare() {
  let judge = "codex",
    model;
  const seen = new Set();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index],
      value = flags[index + 1];
    if (
      !["--judge", "--model"].includes(flag) ||
      !value?.trim() ||
      value.startsWith("--") ||
      seen.has(flag)
    )
      throw new Error(usage);
    seen.add(flag);
    if (flag === "--judge") judge = value;
    else model = value;
  }
  if (!["codex", "mock"].includes(judge))
    throw new Error(
      "This bounded comparison supports codex or mock; mock measures workflow contracts only.",
    );
  fs.accessSync(cli);
  fs.mkdirSync(root);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, "specs"));
  fs.mkdirSync(path.join(root, "preparation"));
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(root, "preparation", "pilot.mjs"));
  fs.copyFileSync(
    new URL("./pilot-collect.mjs", import.meta.url),
    path.join(project, "collect.mjs"),
  );
  write(path.join(project, "browser-module.json"), import.meta.resolve("playwright"));
  const config = {
    version: 1,
    project: { name: "Bounded browser, invoice, and policy judge pilot", root: "." },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: { provider: judge, ...(model ? { model } : {}), timeoutSeconds: 300 },
    paths: { specs: "specs", runs: "../collections" },
    scoring: { minimumCoverage: 100 },
  };
  const configurations = ["medium", "high"].map((effort) => {
    const file = `judge-${effort}.yaml`;
    write(path.join(project, file), { ...config, judge: { ...config.judge, effort } });
    return { id: effort, config: `project/${file}` };
  });
  for (const [family, definition] of Object.entries(criteria)) {
    const scenario = family === "browser" ? "BROWSE" : "EXPORT";
    write(path.join(project, "specs", `${family}.yaml`), {
      id: family,
      title: `${family} evidence`,
      weight: family === "text" ? 40 : 30,
      description:
        "Controlled fixture family; agent-authored expectations kept outside judge inputs.",
      scenarios:
        family === "text"
          ? []
          : [
              {
                id: scenario,
                name:
                  family === "browser" ? "Change quantity and reload" : "Execute invoice export",
                kind: "command",
                instructions:
                  "Collect actual runtime observations without deciding the rubric verdict.",
                collect: {
                  command: `node collect.mjs ${family}`,
                  methodFiles: ["collect.mjs", "browser-module.json"],
                  sources: {
                    subject: `${family === "browser" ? "page.html" : "exporter.mjs"}`,
                    scope: "scope.txt",
                  },
                  images: family === "browser" ? ["before", "after"] : [],
                  ...(family === "file" ? { files: ["invoice"] } : {}),
                  timeoutSeconds: 60,
                },
              },
            ],
      rubric: [
        {
          id: family === "text" ? "POLICY" : family === "browser" ? "PERSISTENCE" : "INVOICE",
          ...definition,
          weight: 1,
          scenarios: family === "text" ? [] : [scenario],
          grader:
            family === "text"
              ? {
                  type: "text-rubric",
                  // Both source and response are fixed case evidence, not replaceable judging references.
                  inputs: { packet: { file: "policy-packet.txt", role: "candidate" } },
                  voting: { minimumVotes: 1, maximumVotes: 1, agreement: 1 },
                }
              : { type: "llm" },
        },
      ],
    });
  }
  fs.writeFileSync(path.join(project, "scope.txt"), "available\n");
  fs.writeFileSync(path.join(project, "page.html"), browserPage("good"));
  fs.writeFileSync(path.join(project, "exporter.mjs"), invoiceExporter("good"));
  fs.writeFileSync(path.join(project, "policy-packet.txt"), policyPacket("good"));
  const cases = [],
    labels = [],
    cards = [];
  // Case IDs and review headings omit variant names; expectations stay in their sidecar.
  const variants = ["variation", "withheld", "good", "defect"];
  let ordinal = 0;
  for (const family of ["browser", "file", "text"])
    for (const variant of variants) {
      const id = `case-${String(++ordinal).padStart(2, "0")}`;
      fs.writeFileSync(
        path.join(project, "scope.txt"),
        variant === "withheld" ? "withheld\n" : "available\n",
      );
      fs.writeFileSync(path.join(project, "page.html"), browserPage(variant));
      fs.writeFileSync(path.join(project, "exporter.mjs"), invoiceExporter(variant));
      fs.writeFileSync(path.join(project, "policy-packet.txt"), policyPacket(variant));
      const runs = path.join(root, "collections");
      const before = new Set(fs.existsSync(runs) ? fs.readdirSync(runs) : []);
      const stdout = aek(
        ["collect", "--config", configurations[0].config, "--areas", family, "--split", "all"],
        root,
      );
      fs.writeFileSync(path.join(root, "preparation", `${id}.stdout.txt`), stdout);
      const added = fs.readdirSync(runs).filter((name) => !before.has(name));
      if (added.length !== 1) throw new Error("Expected exactly one collection per case");
      const directory = path.join(runs, added[0]);
      const index = assertArtifactIntegrity(directory, { require: true });
      const rubric =
        family === "text" ? "POLICY" : family === "browser" ? "PERSISTENCE" : "INVOICE";
      const refs =
        family === "text"
          ? [`inputs/textCandidates/${sha256("POLICY/packet")}.txt`]
          : [
              `${family === "browser" ? "BROWSE" : "EXPORT"}/evidence.json`,
              ...index.entries
                .map((entry) => entry.path)
                .filter((file) =>
                  family === "browser"
                    ? /^BROWSE\/screenshots\//.test(file)
                    : /^EXPORT\/files\//.test(file),
                ),
            ];
      cases.push({
        id,
        group: `${family}-family`,
        split: family === "text" ? "evaluation" : "development",
        evidence: { directory: path.relative(root, directory), rootSha256: index.rootSha256 },
        area: family,
        rubric,
        sources: [],
      });
      labels.push({
        caseId: id,
        evidenceRootSha256: index.rootSha256,
        area: family,
        rubric,
        reviewer: { name: "AEK pilot fixture author", kind: "agent" },
        application: {
          verdict:
            variant === "defect" || (family === "file" && variant === "withheld") ? "fail" : "pass",
          rationale: `Controlled ${family} fixture: ${variant}. No live-product behavior is claimed.`,
          sources: ["Recorded pilot fixture definition; see examples/judge-validation/pilot.mjs"],
        },
        evidence: {
          verdict: variant === "withheld" ? "cannot_judge" : variant === "defect" ? "fail" : "pass",
          rationale:
            variant === "withheld"
              ? "The required runtime observation or source policy is unavailable; underlying target state cannot replace it."
              : variant === "defect"
                ? "The observed persistence, invoice subtotal, or refund deadline contradicts the stated requirement."
                : "The observed result satisfies the requirement; equivalent presentation is acceptable.",
          refs,
        },
      });
      const previews = refs
        .map((ref) => {
          const href = `collections/${added[0]}/${ref}`;
          if (ref.endsWith(".png"))
            return `<img alt="Collected runtime evidence" src="${escapeHtml(href)}" style="max-width:100%">`;
          const artifact = jsonIfEvidence(path.join(directory, ref), ref);
          return `<p><a href="${escapeHtml(href)}">${escapeHtml(ref)}</a></p><pre>${escapeHtml(artifact)}</pre>`;
        })
        .join("");
      cards.push(
        `<section><h2>${id} · ${family}</h2><p>${escapeHtml(criteria[family].criterion)}</p><p>${escapeHtml(criteria[family].passCriteria)}</p>${previews}<p>Record pass, fail, or cannot_judge, a short reason, and supporting references. Judge predictions and fixture expectations are intentionally absent.</p></section>`,
      );
      console.log(`Collected ${id} (${family})`);
    }
  write(path.join(root, "labels.agent.json"), { version: 1, labels });
  write(path.join(root, "configurations.json"), { version: 1, configurations });
  write(path.join(root, "human-review.template.json"), {
    version: 1,
    labels: labels.map((label) => ({
      ...label,
      reviewer: { name: "", kind: "human" },
      application: {
        verdict: "unknown",
        rationale: "No independent application review",
        sources: ["Evidence-only review"],
      },
      evidence: { verdict: null, rationale: "", refs: [] },
    })),
  });
  fs.writeFileSync(
    path.join(root, "review.html"),
    reportDocument(
      "Independent pilot review",
      `<h1>Independent pilot review</h1><p>Review these twelve evidence packages before opening labels.agent.json or any comparison report. Assess what the evidence supports, not what an unseen application might do. Reply with each case ID, pass/fail/cannot_judge, and a reason. The optional JSON template remains invalid until the reviewer and decisions are supplied.</p><p>For command-collected evidence, the transcript records collector execution; observations and extraction descriptions are project-supplied claims. Screenshots establish sampled visible states. Assess whether the supplied action evidence establishes the required sequence, and use cannot_judge when it is insufficient. Collector identity and the recorded transcript appear in each runtime evidence preview below.</p>${cards.join("")}`,
    ),
  );
  write(path.join(root, "pilot.json"), {
    version: 1,
    preparedAt: new Date().toISOString(),
    judge,
    ...(model ? { model } : {}),
    families: 3,
    cases: cases.length,
    plannedAttempts: cases.length * configurations.length,
    labels: "agent-authored; independent human review pending",
    evaluationFamily: "text-family; not used for tuning these configurations",
    caseIdentitySha256: caseIdentityHash({ cases }),
    inputs: Object.fromEntries(
      preparedFiles.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]),
    ),
    limitations: [
      "Twelve controlled fixtures in three families do not establish general judge accuracy.",
      "Model-free Playwright and command collectors exercise real local code; collection-agent investigation quality is outside this pilot.",
      "Model checking of exact invoice arithmetic is diagnostic; a production suite should use an independent deterministic gate for exact arithmetic.",
    ],
  });
  const sources = ["pilot.json", "preparation/pilot.mjs"].map((file) => ({
    path: file,
    sha256: sha256(fs.readFileSync(path.join(root, file))),
  }));
  for (const item of cases) item.sources = sources;
  write(path.join(root, "cases.json"), { version: 1, cases });
  console.log(
    `Independent review: ${path.join(root, "review.html")}\nCompare: node ${fileURLToPath(import.meta.url)} compare ${root}`,
  );
}

function browserPage(variant) {
  const remember = variant !== "defect";
  const caption = variant === "variation" ? "Units in basket" : "Quantity";
  return `<!doctype html><meta charset="utf-8"><title>Cart</title><style>body{font:24px system-ui;margin:60px}input{font:inherit;width:100px}</style><h1>Notebook cart</h1><p>Unit price: 500 cents</p><label>${caption} <input id="quantity" type="number" min="1"></label><p>Subtotal: <span id="subtotal"></span> cents</p><script>const field=document.querySelector('#quantity');field.value=${remember ? "localStorage.getItem('quantity')||'1'" : "'1'"};function render(){document.querySelector('#subtotal').textContent=Number(field.value)*500;}field.addEventListener('change',()=>{${remember ? "localStorage.setItem('quantity',field.value);" : ""}render();});render();</script>`;
}

function invoiceExporter(variant) {
  const wrong = variant === "defect" || variant === "withheld";
  return `export function exportInvoice(items) { return { ${variant === "variation" ? "note:'Thank you'," : ""}items, subtotalCents: items.reduce((sum,line)=>sum+line.priceCents${wrong ? "" : "*line.quantity"},0) }; }\n`;
}

function policyPacket(variant) {
  const policy =
    variant === "withheld"
      ? "The supplied excerpt describes contact routing only. The refund policy section is unavailable."
      : "Customers may request a refund within 30 calendar days after purchase.";
  const response =
    variant === "defect"
      ? "You can request a refund within 60 calendar days after purchase."
      : variant === "variation"
        ? "Refund requests are accepted up to thirty calendar days after you purchase."
        : "You can request a refund within 30 calendar days after purchase.";
  return `Supplied policy record:\n${policy}\n\nCustomer response:\n${response}\n`;
}

function jsonIfEvidence(file, ref) {
  if (!ref.endsWith("/evidence.json")) return fs.readFileSync(file, "utf8");
  const evidence = json(file);
  return JSON.stringify(
    {
      kind: evidence.kind,
      collector: evidence.collector,
      outcome: evidence.outcome,
      summary: evidence.summary,
      observations: evidence.observations,
      screenshots: evidence.screenshots,
      files: evidence.files,
      transcript: evidence.transcript,
    },
    null,
    2,
  );
}

function summarize() {
  const comparison = path.join(root, "comparison");
  const { report, dataset, sha256: comparisonSha256 } = loadJudgeValidationReview(comparison);
  const pilot = loadPilot(dataset);
  // A completed comparison is self-contained; check its snapshots, not live configs.
  assertPreparedInput(pilot, "labels.agent.json", report.inputs.labels.sha256);
  assertPreparedInput(pilot, "configurations.json", report.inputs.configurationManifest.sha256);
  for (const configuration of report.inputs.configurations)
    assertPreparedInput(pilot, `project/judge-${configuration.id}.yaml`, configuration.sha256);
  const timings = report.observations.map((observation) => {
    if (observation.status === "execution_error")
      return {
        caseId: observation.caseId,
        configuration: observation.configuration,
        durationMs: null,
        providerCalls: null,
        status: observation.status,
      };
    const index = assertArtifactIntegrity(observation.runDir, { require: true });
    const run = json(path.join(observation.runDir, "report.json"));
    const item = dataset.cases.find((item) => item.id === observation.caseId);
    assertPreparedInput(
      pilot,
      `project/specs/${item.area}.yaml`,
      run.receipt.inputs.specs[item.area].sha256,
    );
    const durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error("Invalid retained run timing");
    return {
      caseId: observation.caseId,
      configuration: observation.configuration,
      durationMs,
      providerCalls: index.entries.filter((entry) => entry.path.endsWith("/provider-run.json"))
        .length,
      status: observation.status,
    };
  });
  const summary = { ...pilot, comparisonSha256, results: report.results, timings };
  fs.writeFileSync(path.join(root, "pilot-summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
  });
  const rows = report.results
    .map((result) => {
      const time = timings.filter((item) => item.configuration === result.configuration);
      const duration = time.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
      const cells = [
        "falsePasses",
        "falseFailures",
        "abstentions",
        "executionErrors",
        "decisionCoverage",
        "unsupportedDecisions",
      ].map((name) => `${result.metrics[name].count}/${result.metrics[name].denominator}`);
      return `<tr><td>${escapeHtml(result.configuration)}</td>${cells.map((cell) => `<td>${cell}</td>`).join("")}<td>${(duration / 1000).toFixed(1)}s</td></tr>`;
    })
    .join("");
  fs.writeFileSync(
    path.join(root, "pilot-summary.html"),
    reportDocument(
      "Bounded judge pilot",
      `<h1>Bounded judge pilot</h1><p>${escapeHtml(pilot.labels)}. ${pilot.cases} cases across ${pilot.families} related families. ${pilot.judge === "mock" ? "Mock judges establish workflow behavior only; this is not model accuracy evidence." : "Results describe these fixtures and requested judge configurations only."}</p><table><thead><tr><th>Configuration</th><th>False passes</th><th>False failures</th><th>Abstentions</th><th>Errors</th><th>Decision coverage</th><th>Unsupported decisions</th><th>Completed judging time</th></tr></thead><tbody>${rows}</tbody></table><p>Time sums completed judging-run durations, including harness work; failed-attempt durations are unavailable. Provider-call counts and per-attempt timing are in <a href="pilot-summary.json">JSON</a>. This single sweep does not establish stability or a speed ranking.</p><p><a href="comparison/validation-results.html">All decisions and evidence</a> · <a href="review.html">Independent review packet (no predictions)</a></p><ul>${pilot.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    ),
    { flag: "wx" },
  );
  console.log(`Open ${path.join(root, "pilot-summary.html")}`);
}

if (command === "prepare") prepare();
else if (command === "compare") {
  const dataset = validationDatasetSchema.parse(json(path.join(root, "cases.json")));
  const pilot = loadPilot(dataset);
  for (const file of preparedFiles)
    assertPreparedInput(pilot, file, sha256(fs.readFileSync(path.join(root, file))));
  console.log(`Running the pinned comparison in ${root}`);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "judge",
      "validate",
      "--dataset",
      "cases.json",
      "--labels",
      "labels.agent.json",
      "--configurations",
      "configurations.json",
      "--output",
      "comparison",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Comparison exited ${result.status}; retained diagnostics remain under ${root}`,
    );
  summarize();
} else summarize();
