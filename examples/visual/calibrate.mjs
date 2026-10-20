import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PROVIDERS } from "../../dist/types.js";

// Synthetic, agent-labelled calibration. No browser, application or third-party pixels.
const [destination, ...args] = process.argv.slice(2);
if (!destination)
  throw new Error(
    `Usage: node calibrate.mjs NEW_DIRECTORY [--prepare-only] [--model MODEL] [--effort EFFORT] [--provider ${PROVIDERS.join("|")}] [--fidelity-rubric FILE] [--ui-rubric FILE]`,
  );
const prepareOnly = args.includes("--prepare-only");
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  if (seen.has(args[i])) throw new Error(`Duplicate option ${args[i]}`);
  seen.add(args[i]);
  if (args[i] === "--prepare-only") continue;
  if (!["--model", "--effort", "--provider", "--fidelity-rubric", "--ui-rubric"].includes(args[i]))
    throw new Error(`Unknown option ${args[i]}`);
  value(args[i]);
  i++;
}
const judge = { provider: value("--provider") ?? "codex", concurrency: 4, timeoutSeconds: 180 };
if (!PROVIDERS.includes(judge.provider))
  throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}`);
if (value("--model")) judge.model = value("--model");
if (value("--effort")) judge.effort = value("--effort");
if (judge.provider === "cursor" && judge.effort !== undefined)
  throw new Error("Cursor does not support --effort; omit it and configure --model instead");
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const root = path.resolve(destination);
fs.mkdirSync(root); // Existing evidence is never overwritten.
const project = path.join(root, "project");
fs.mkdirSync(project);
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
const aek = (...command) => {
  const result = spawnSync(process.execPath, [cli, ...command], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`AEK ${command.join(" ")}\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
};
const scene = (variant) => {
  const unreadable = variant === "unreadable-ui";
  const buildings = Array.from({ length: 9 }, (_, i) => {
    const x = 45 + i * 82,
      height = 80 + ((i * 47) % 140),
      y = 345 - height;
    const windows = Array.from({ length: Math.floor((height - 20) / 22) }, (_, row) =>
      Array.from(
        { length: 3 },
        (_, col) =>
          `<rect x="${x + 8 + col * 15}" y="${y + 12 + row * 22}" width="9" height="12" fill="#d5e7ec"/>`,
      ).join(""),
    ).join("");
    return `<path d="M${x},${y}h56l16,-12h-56z" fill="#bac1bb"/><rect x="${x}" y="${y}" width="56" height="${height}" fill="url(#wall)"/><path d="M${x + 56},${y}l16,-12v${height}l-16,12z" fill="#42596a"/>${windows}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#568aa8"/><stop offset="1" stop-color="#e9d3ac"/></linearGradient><linearGradient id="wall"><stop stop-color="#b39f82"/><stop offset="1" stop-color="#6f8490"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="8"/></filter></defs>
  <rect width="800" height="500" fill="#203342"/>
  <g font-family="sans-serif" fill="${unreadable ? "#263b47" : "#f1f7fa"}">
    <text x="24" y="40" font-size="${unreadable ? 2 : 28}">Transit field</text>
    <text x="24" y="72" font-size="${unreadable ? 2 : 17}">Live network · 3 routes · weekday service</text>
    ${variant === "blurred-world" ? '<text x="430" y="34" font-size="17">ACCESS 92% · GROWTH ACTIVE</text><text x="430" y="65" font-size="17">Demand: rush hour · network healthy</text>' : ""}
  </g>
  <g ${variant === "blurred-world" ? 'filter="url(#blur)"' : ""}>
    <rect y="100" width="800" height="400" fill="url(#sky)"/>
    <path d="M0,285L130,190L240,270L390,165L540,255L670,178L800,280V400H0Z" fill="#8eaaab"/>
    <rect y="330" width="800" height="170" fill="#698568"/>
    ${buildings}
    <path d="M285,345H515L690,500H110Z" fill="#414b51"/>
    <path d="M396,350L382,380M377,390L357,430M351,442L324,499" stroke="#e2d2a0" stroke-width="5"/>
    <path d="M0,365H800" stroke="#c2bbac" stroke-width="12"/>
    ${[150, 585, 655].map((x) => `<ellipse cx="${x + 12}" cy="423" rx="22" ry="8" fill="#293d39"/><rect x="${x}" y="359" width="7" height="60" fill="#5a5145"/><circle cx="${x + 3}" cy="354" r="25" fill="#3f6e51"/>`).join("")}
    <path d="M428,385h46l12,20h-64z" fill="#bd6959"/><rect x="435" y="383" width="30" height="14" fill="#c9e0e3"/>
    <path d="M255,449h59l19,28h-85z" fill="#d4b46b"/><rect x="266" y="447" width="37" height="16" fill="#9ab8c4"/>
  </g></svg>`;
};
fs.writeFileSync(path.join(project, "reference.svg"), scene("working"));
fs.writeFileSync(
  path.join(project, "collect.mjs"),
  `import fs from 'node:fs';import path from 'node:path';
const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8'));
fs.copyFileSync(c.sources.image.path,path.join(c.outputDir,'image.svg'));
console.log(JSON.stringify({version:1,outcome:'completed',summary:'Collected authored synthetic visual fixture.',observations:['Authored control or deliberate visual defect; no application behavior is inferred.'],images:[{label:'image',path:'image.svg',source:'image',extraction:'Copied the sealed authored SVG; AEK decodes it at its intrinsic 800x500 size.'}]}));\n`,
);
const spec = {
  id: "visual-calibration",
  title: "Visual fidelity and interface clarity",
  weight: 100,
  description:
    "A bounded synthetic development family with independent, agent-authored expectations.",
  scenarios: [
    {
      id: "IMAGE",
      name: "Authored visual fixture",
      kind: "command",
      instructions: "Collect the authored image.",
      collect: {
        command: "node collect.mjs",
        methodFiles: ["collect.mjs"],
        sources: { image: "candidate.svg" },
        images: ["image"],
      },
    },
  ],
  rubric: [
    {
      id: "FIDELITY",
      criterion:
        "Preserve visible environmental production quality: spatial depth, surface detail, lighting, and technical cleanliness. More labels, metrics, or feature claims cannot compensate for weaker rendering. Interface clarity is assessed separately.",
      weight: 1,
      gate: true,
      scenarios: ["IMAGE"],
      grader: {
        type: "pairwise",
        candidate: "image",
        policy: "non_regression",
        references: [
          {
            file: "reference.svg",
            crop: { x: 0, y: 0.2, width: 1, height: 0.8 },
            candidateCrop: { x: 0, y: 0.2, width: 1, height: 0.8 },
          },
        ],
        panel: { width: 800, height: 400, fit: "contain" },
        voting: { minimumVotes: 3, maximumVotes: 5, agreement: 0.8, minimumConfidence: 0.55 },
      },
      passCriteria:
        "The rendered environment is preferable or demonstrably equivalent to the reference. Visible loss of focus or surface detail fails. Extra interface text does not decide fidelity.",
    },
    {
      id: "UI",
      criterion:
        "The candidate's heading and subtitle are readable at the supplied 800x500 viewport, with adequate contrast and no clipping or overlap. Environmental fidelity cannot compensate for unreadable text.",
      weight: 1,
      gate: true,
      scenarios: ["IMAGE"],
      grader: { type: "llm" },
      passCriteria:
        "Both the heading and subtitle are readable from the screenshot. Fail when text is too small or low contrast to read. Do not infer behavior or data accuracy.",
      evidence: "The candidate image, including its heading and subtitle.",
    },
  ],
};
for (const [flag, id] of [
  ["--fidelity-rubric", "FIDELITY"],
  ["--ui-rubric", "UI"],
]) {
  const file = value(flag);
  if (file) {
    const criterion = fs.readFileSync(path.resolve(file), "utf8").trim();
    if (!criterion) throw new Error(`${flag} must contain a criterion`);
    spec.rubric.find((item) => item.id === id).criterion = criterion;
  }
}
write(path.join(project, "spec.yaml"), spec);
const config = {
  version: 1,
  project: { name: "Visual calibration", root: "." },
  target: { kind: "repository" },
  agent: { provider: "mock" },
  judge,
  paths: { specs: "spec.yaml", runs: "../collections" },
  scoring: { minimumCoverage: 100 },
};
const configFile = path.join(project, "evalkit.yaml");
write(configFile, config);
const cases = [],
  labels = [];
for (const variant of ["working", "blurred-world", "unreadable-ui"]) {
  fs.writeFileSync(path.join(project, "candidate.svg"), scene(variant));
  const runs = path.join(root, "collections");
  const before = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  aek("collect", "--config", configFile);
  const added = fs.readdirSync(runs).filter((name) => !before.includes(name));
  if (added.length !== 1) throw new Error("Expected one sealed collection per fixture");
  const directory = path.join(runs, added[0]);
  const { rootSha256 } = JSON.parse(
    fs.readFileSync(path.join(directory, "artifact-index.json"), "utf8"),
  );
  for (const rubric of ["FIDELITY", "UI"]) {
    const expected =
      (rubric === "FIDELITY" && variant === "blurred-world") ||
      (rubric === "UI" && variant === "unreadable-ui")
        ? "fail"
        : "pass";
    const id = `${variant}-${rubric.toLowerCase()}`;
    cases.push({
      id,
      group: "authored-visual-family",
      split: "development",
      evidence: { directory, rootSha256 },
      area: spec.id,
      rubric,
      sources: [],
    });
    const rationale =
      rubric === "FIDELITY"
        ? expected === "fail"
          ? "The authored Gaussian blur removes environmental detail while leaving extra interface claims readable."
          : "The cropped environment is byte-equivalent to the reference; interface changes lie outside this fidelity region."
        : expected === "fail"
          ? "The heading and subtitle are authored at two pixels with near-background contrast."
          : "The heading and subtitle use readable sizes and contrast; world blur does not obscure interface text.";
    labels.push({
      caseId: id,
      evidenceRootSha256: rootSha256,
      area: spec.id,
      rubric,
      reviewer: { name: "Synthetic visual fixture author", kind: "agent" },
      application: {
        verdict: expected,
        rationale,
        sources: ["Authored synthetic fixture construction; no real application outcome claimed."],
      },
      evidence: { verdict: expected, rationale, refs: ["IMAGE/screenshots/image.png"] },
    });
  }
}
write(path.join(root, "cases.json"), { version: 1, cases });
write(path.join(root, "labels.json"), { version: 1, labels });
write(path.join(root, "configurations.json"), {
  version: 1,
  configurations: [{ id: "separated", config: "project/evalkit.yaml" }],
});
if (!prepareOnly)
  aek(
    "judge",
    "validate",
    "--dataset",
    "cases.json",
    "--labels",
    "labels.json",
    "--configurations",
    "configurations.json",
    "--output",
    "comparison",
  );
console.log(
  `Prepared ${cases.length} labelled checks over three sealed visual collections in ${root}. Labels are agent-authored; this is a small development calibration, not a held-out or human accuracy claim.`,
);
