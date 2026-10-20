/** Self-contained assets for installed consumers; no source-checkout paths. */
const scenario = `scenarios:
  - id: FIELD
    name: Seeded signal field
    kind: browser
    instructions: Capture the field at three fixed logical times.
    capture:
      seed: 1337
      setup: { palette: day }
      readySelector: canvas
      timeoutSeconds: 180
      readinessTimeoutSeconds: 30
      screenshotTimeoutSeconds: 30
      renderer: software
      passes: 2
      frames: 3
      stepSeconds: 0.5
      channelTolerance: 0
      maximumChangedPixelRatio: 0
      movementChannelTolerance: 2
      minimumMovement: 0.001
      rejectDuplicateFrames: true
      imageHealth:
        crop: { x: 0.1, y: 0.25, width: 0.8, height: 0.65 }
        metrics:
          entropy: { min: 0.5 }
          stdev: { min: 5 }
          gradientEnergy: { min: 0.1 }
      metrics:
        rendering.errors: { equals: 0 }
        simulation.time: { min: 0 }
`;

const captureRubric = `  - id: CAPTURE
    criterion: Rendering is healthy, repeatable, moving, and free of runtime errors
    weight: 1
    gate: true
    scenarios: [FIELD]
    grader: { type: capture }
    passCriteria: Every configured capture, motion, metric, and browser diagnostic check passes.
`;

function spec(comparison?: "baseline" | "aspirational"): string {
  return `id: visual
title: Controlled visual evaluation
weight: 100
description: Deterministic capture with separately selected visual comparison policies.
${scenario}rubric:
${captureRubric}${
  comparison
    ? `  - id: ${comparison === "baseline" ? "NON_REGRESSION" : "ASPIRATIONAL"}
    criterion: ${comparison === "baseline" ? "Preserve the approved field's visual finish, spatial hierarchy, and rendered signal quality" : "Improve rendered signal quality, spatial hierarchy, and visual finish over the illustrative target"}. Judge visible production quality; extra labels, controls, or feature claims cannot compensate for weaker rendering. Interface readability is assessed separately.
    weight: 1
    gate: true
    scenarios: [FIELD]
    grader:
      type: pairwise
      candidate: frame-001
      policy: ${comparison === "baseline" ? "non_regression" : "preference"}
      references:
        - ${comparison === "baseline" ? "baseline: approved\n          label: frame-001" : "file: evals/visual/aspirational.svg"}
      panel: { width: 800, height: 500, fit: contain, background: '#102437' }
      voting: { minimumVotes: 3, maximumVotes: 5, agreement: 0.8, minimumConfidence: 0.55 }
    passCriteria: ${comparison === "baseline" ? "The candidate is visually preferable or demonstrably equivalent on the stated visual dimensions." : "The candidate is visibly preferable on the stated visual dimensions; equivalence does not satisfy this strict improvement requirement. This comparison alone does not establish absolute quality."} Do not penalize a reference for lacking the candidate's controls or explanatory text.
  - id: UI_CLARITY
    criterion: The candidate's heading and subtitle are readable and do not obscure the signal field
    weight: 1
    gate: true
    scenarios: [FIELD]
    grader: { type: llm }
    passCriteria: The heading and subtitle have adequate contrast, readable type, and no clipping or overlap. The signal field remains usable. Judge visible readability without inferring interaction success. Rendered fidelity cannot compensate for unreadable interface text.
    evidence: The candidate screenshots at the configured viewport.
`
    : ""
}`;
}

const config = `version: 1
project: { name: Controlled visual starter, root: . }
target:
  kind: web
  url: http://127.0.0.1:4189/
  start: node evals/visual/server.mjs
  ready: { url: 'http://127.0.0.1:4189/', timeoutSeconds: 30 }
agent: { provider: mock }
judge: { provider: mock, timeoutSeconds: 180 }
paths:
  specs: evals/specs/core.yaml
  runs: .agent-eval/runs
  baselines: evals/baselines
browser:
  viewport: { width: 800, height: 500 }
  diagnostics:
    failOn: [console, pageerror, requestfailed, http]
scoring: { minimumCoverage: 100 }
promotion: { split: all, minimumCoverage: 100 }
suite: checks
suites:
  checks: {}
  baseline:
    paths: { specs: evals/visual/baseline.yaml }
    judge: { provider: codex }
  aspirational:
    paths: { specs: evals/visual/aspirational.yaml }
    judge: { provider: codex }
`;

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal field — controlled visual fixture</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#102437;color:#eff8ff;font:16px system-ui}
canvas{display:block;width:100%;height:100%}header{position:absolute;left:28px;top:24px;pointer-events:none}
h1{margin:0 0 8px;font-size:28px}p{margin:0;color:#b7d7eb}
</style>
<canvas aria-label="Seeded moving signals"></canvas>
<header><h1>Signal field</h1><p>Three signals · fixed logical time · seeded layout</p></header>
<script type="module" src="/scene.mjs"></script>
</html>
`;

const scene = String.raw`// Replace this fixture with your application's reset/seed/configure adapter.
// Rendering advances only through advance(); wall-clock time never changes pixels.
const query = new URLSearchParams(location.search);
const renderer = query.get("renderer") ?? "webgl";
const variant = query.get("variant") ?? "working";
if (!["webgl", "canvas"].includes(renderer)) throw new Error("Unknown renderer");
if (!["working", "frozen", "blank"].includes(variant)) throw new Error("Unknown variant");
const canvas = document.querySelector("canvas");
canvas.width = innerWidth;
canvas.height = innerHeight;
let time = 0, seed = 1337;
const palette = ["#52d5c5", "#ffcc72", "#6cb8ff"];
let draw;
let diagnostics;
if (renderer === "webgl") {
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 is required; use ?renderer=canvas to explicitly select Canvas2D");
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 point;void main(){gl_Position=vec4(point,0.,1.);}'));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;uniform vec2 size;uniform float clock;uniform float seed;out vec4 color;void main(){vec2 uv=gl_FragCoord.xy/size;vec3 c=mix(vec3(.035,.09,.15),vec3(.09,.22,.29),uv.y);vec2 grid=abs(fract(uv*vec2(16.,10.))-.5);c+=.035*(1.-step(.015,min(grid.x,grid.y)));for(int i=0;i<3;i++){float f=float(i);vec2 center=vec2(.2+f*.29+clock*.075,.32+f*.13+mod(seed,7.)*.003);float d=length((uv-center)*vec2(size.x/size.y,1.));vec3 ink=i==0?vec3(.32,.84,.77):(i==1?vec3(1.,.8,.45):vec3(.42,.72,1.));c=mix(c,ink,1.-smoothstep(.057,.06,d));c+=ink*.09*(1.-smoothstep(.06,.13,d));}color=vec4(c,1.);}'));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  const point = gl.getAttribLocation(program, "point");
  gl.enableVertexAttribArray(point);
  gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
  draw = () => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(.063,.141,.216,1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (variant !== "blank") {
      gl.uniform2f(gl.getUniformLocation(program, "size"), canvas.width, canvas.height);
      gl.uniform1f(gl.getUniformLocation(program, "clock"), time);
      gl.uniform1f(gl.getUniformLocation(program, "seed"), seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.finish();
    if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL rendering failed");
  };
  diagnostics = () => ({ renderer, version: gl.getParameter(gl.VERSION), time, seed, variant });
} else {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D is required");
  draw = () => {
    context.fillStyle = "#102437";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (variant === "blank") return;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#0a1b2a");gradient.addColorStop(1, "#25536b");
    context.fillStyle = gradient;context.fillRect(0, 0, canvas.width, canvas.height);
    for (let i=0;i<3;i++) {
      context.fillStyle = palette[i];context.beginPath();
      context.arc(canvas.width*(.2+i*.29+time*.075),canvas.height*(.68-i*.13-(seed%7)*.003),30,0,Math.PI*2);context.fill();
    }
  };
  diagnostics = () => ({ renderer, time, seed, variant });
}
window.__AEK_EVAL__ = {
  reset() { time=0;draw(); },
  setSeed(value) { if (!Number.isInteger(value)) throw new Error("seed must be an integer");seed=value;draw(); },
  configure({ palette: name }) { if (name !== "day") throw new Error("Unknown palette");draw(); },
  async waitUntilStable() { await document.fonts.ready;draw(); },
  advance(seconds) { if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid logical time step");if (variant !== "frozen") time+=seconds;draw(); },
  getMetrics() { return { rendering: { errors: 0 }, simulation: { time } }; },
  getDiagnostics() { return diagnostics(); }
};
draw();
`;

const server = `import fs from "node:fs";
import http from "node:http";
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/scene.mjs", ["scene.mjs", "text/javascript; charset=utf-8"]]
]);
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/favicon.ico") { response.writeHead(204).end();return; }
  const asset = assets.get(pathname);
  if (!asset) { response.writeHead(404).end("Not found");return; }
  response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
  response.end(fs.readFileSync(new URL(asset[0], import.meta.url)));
});
server.listen(Number(process.env.AEK_VISUAL_PORT ?? 4189), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
`;

const target = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
<rect width="800" height="500" fill="#102437"/>
<text x="32" y="52" fill="#eff8ff" font-size="28" font-family="sans-serif">Signal field</text>
<text x="32" y="82" fill="#b7d7eb" font-size="16" font-family="sans-serif">Illustrative target · readable signals and a clear hierarchy</text>
<path d="M160 340L392 275L624 210" stroke="#4c7a96" stroke-width="3" fill="none"/>
<g stroke="#e0f4ff" stroke-width="2"><circle cx="160" cy="340" r="30" fill="#52d5c5"/><circle cx="392" cy="275" r="30" fill="#ffcc72"/><circle cx="624" cy="210" r="30" fill="#6cb8ff"/></g>
<g fill="#eff8ff" font-size="16" font-family="sans-serif"><text x="130" y="397">North</text><text x="362" y="332">Central</text><text x="594" y="267">South</text></g>
</svg>
`;

const onboarding = `# Controlled visual starter

This is a runnable calibration fixture, not an evaluation of your application.
Run commands from this project root using your installed aek executable (for a
local npm dependency, prefix with npx --no-install). Add .agent-eval/ to .gitignore.
Install matching Chromium with npx --no-install playwright install chromium.

## Calibrate capture without a subscription

The default checks suite uses no model calls. The WebGL2 fixture runs through
SwiftShader. A Canvas2D implementation is explicitly selectable with
?renderer=canvas; missing WebGL never silently switches renderers.

1. Run aek validate, then aek run --split all. Expect exit 0, 100% coverage,
   CAPTURE=pass, and repeatable frames with visible movement. Inspect report.html.
2. Run aek run --split all --url 'http://127.0.0.1:4189/?variant=frozen'. Expect
   exit 2, 100% coverage, and CAPTURE=fail on movement/duplicate checks.
3. Run aek run --split all --url 'http://127.0.0.1:4189/?variant=blank'. Expect
   exit 2, 100% coverage, and CAPTURE=fail on image-health checks in the canvas region.
4. Restore the working target with aek run --split all. Retain this NEW run's path.

These are observed check failures, not model quality claims. A shader error,
missing adapter, corrupt image, or timeout must instead produce execution exit 1.
Keep the evaluator fixed across the three variants. Query parameters change the
fixture under test; the adapter does not select a different evaluation policy.

## Establish a reviewed baseline

Review the working run's pixels and checks. Then explicitly promote it:

\x60\x60\x60sh
aek baseline promote --suite checks --run /path/to/working-run --name approved --reviewer YOUR_NAME --include-images
aek run --suite baseline --split all
\x60\x60\x60

The baseline suite adds a blind non_regression comparison: wins or observed
equivalence can pass. It requires the approved image-bearing baseline and a
logged-in Codex judge. Missing baseline images fail before capture; they never
bootstrap from the current candidate. A mock judge abstains and blocks the
comparison gate. Use --judge claude, grok, or cursor to select another provider.

## Assess an aspirational target separately

\x60\x60\x60sh
aek run --suite aspirational --split all
\x60\x60\x60

This suite compares against evals/visual/aspirational.svg using strict preference.
It may legitimately fail on the working fixture: equivalence is insufficient.
The supplied illustration is an example target, not an independently approved
quality standard. Choose reviewed references and concrete criteria for your app.
A relative win alone does not establish absolute quality; add a separate llm
gate for requirements such as text legibility or absence of visible defects.

## Connect your application

Replace target.url/start/readiness and expose the adapter in scene.mjs from your
application. Keep reset, seed, setup, stable rendering, logical time, and metrics
project-owned. waitUntilStable must await required assets, fonts, and render work;
a resolved HTTP request or one animation frame cannot establish asset readiness.
Use rendererPattern when a WebGL renderer is required, and the page adapter's
getDiagnostics method for instrumented provenance.
Replace the fixture metric and image-health bounds with calibrated requirements.
Update all three suite scenarios together; they must exercise the same scenes.
Keep thresholds, comparison policy, and references fixed when comparing revisions.
Use aek collect and aek judge --evidence to calibrate judges over sealed pixels.
Repeated agreement measures consistency, not accuracy; review known-good and
deliberately defective images before treating model verdicts as release gates.
Keep rendered fidelity and interface comprehension independent: additional
labels or metrics cannot rescue weaker rendering, and good rendering cannot
rescue unreadable controls. The baseline and aspirational suites include a
separate UI_CLARITY gate. The installed examples/visual/calibrate.mjs exercise
prepares a sharp control, a blurred world with extra readable metrics, and an
unchanged sharp world with unreadable text, with separate agent-authored labels.
`;

export function visualStarterFiles(): Array<{ relative: string; content: string }> {
  return [
    { relative: "evalkit.yaml", content: config },
    { relative: "evals/specs/core.yaml", content: spec() },
    { relative: "evals/ONBOARDING.md", content: onboarding },
    { relative: "evals/visual/baseline.yaml", content: spec("baseline") },
    { relative: "evals/visual/aspirational.yaml", content: spec("aspirational") },
    { relative: "evals/visual/aspirational.svg", content: target },
    { relative: "evals/visual/index.html", content: html },
    { relative: "evals/visual/scene.mjs", content: scene },
    { relative: "evals/visual/server.mjs", content: server },
  ];
}
