import fs from "node:fs";
import path from "node:path";
import { BrowserSession } from "../browser/session.js";
import { readDiagnostics } from "../browser/diagnostics.js";
import { cancellationSignal, throwIfCancelled } from "../cancellation.js";
import { stableJson, writeJson } from "../io.js";
import type { EvalConfig, Scenario, ScenarioEvidence } from "../types.js";
import { captureSchedule, type CaptureCheck, type CaptureConfig } from "./contracts.js";
import { compareImages, contactSheet, inspectImage } from "./images.js";

export function metricChecks(metrics: unknown, requirements: CaptureConfig["metrics"]): CaptureCheck[] {
  return Object.entries(requirements).map(([name, expected]) => {
    let actual: unknown = metrics;
    for (const key of name.split(".")) actual = actual && typeof actual === "object" && Object.hasOwn(actual, key) ? (actual as Record<string, unknown>)[key] : undefined;
    if (typeof actual !== "number" || !Number.isFinite(actual)) throw new Error(`Required metric ${name} is missing or non-numeric; fix getMetrics()`);
    return { name: `metric.${name}`, actual, expected, pass: (expected.min === undefined || actual >= expected.min) && (expected.max === undefined || actual <= expected.max) && (expected.equals === undefined || actual === expected.equals) };
  });
}

export async function controlledCapture(config: EvalConfig, scenario: Scenario, directory: string, storageState?: string): Promise<ScenarioEvidence> {
  const capture = scenario.capture!;
  const schedule = captureSchedule(capture);
  const startedAt = new Date().toISOString();
  const evidence: ScenarioEvidence = {
    scenarioId: scenario.id, scenarioName: scenario.name, sourceScenarioId: scenario.sourceScenarioId, caseId: scenario.caseId, strata: scenario.strata, split: scenario.split,
    kind: "browser", persona: scenario.persona, collector: "controlled", outcome: "completed", summary: "Controlled capture completed.",
    observations: [], evidenceRefs: [], transcript: [], screenshots: [], captureChecks: [], diagnostics: [],
    artifacts: { capture: "capture.json" }, provider: "mock", startedAt, finishedAt: startedAt, durationMs: 0,
  };
  fs.mkdirSync(directory, { recursive: true });
  const passes: Array<{ frames: string[]; metrics: unknown[]; images: unknown[] }> = [];
  let session: BrowserSession | undefined;
  const signal = cancellationSignal();
  let rejectAbort: (cause: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  let stopped = false;
  const check = () => { throwIfCancelled(); if (stopped) throw new Error("Capture stopped"); };
  const abort = () => { stopped = true; rejectAbort(signal?.reason ?? new Error("Capture interrupted")); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { stopped = true; rejectAbort(new Error(`Controlled capture timed out after ${capture.timeoutSeconds}s; check readiness and adapter methods`)); }, capture.timeoutSeconds * 1000);
  const collect = async () => {
    for (let pass = 0; pass < capture.passes; pass++) {
      check();
      const passName = `pass-${String(pass + 1).padStart(2, "0")}`;
      const passDir = path.join(directory, passName);
      const frames: string[] = [], metrics: unknown[] = [], images: unknown[] = [];
      // Keep partial measurements when a later frame or adapter call fails.
      passes.push({ frames, metrics, images });
      session = new BrowserSession(passDir, config.browser.headless, config.target.url!, storageState, config.target.allowedOrigins, config.browser.viewport, config.browser.actionTimeoutMs, "same-origin", { lossless: true, disableAnimations: true, software: capture.renderer === "software" });
      await session.start();
      check();
      const browser = session;
      const navigation = await browser.navigate(config.target.url!);
      if (/^(ERROR|BLOCKED):/m.test(navigation)) throw new Error(navigation);
      if (capture.readySelector) await browser.page.locator(capture.readySelector).waitFor({ state: "visible" });
      await browser.page.waitForFunction(hook => Boolean((globalThis as unknown as Record<string, unknown>)[hook]), capture.hook);
      const invoke = async (method: string, value?: unknown) => {
        check();
        const before = await browser.preflightOrigin();
        if (before) throw new Error(before);
        const result = await browser.page.evaluate(async ({ hook, method, value }) => {
          const api = (globalThis as unknown as Record<string, Record<string, (arg?: unknown) => unknown>>)[hook];
          if (typeof api?.[method] !== "function") throw new Error(`Required evaluation adapter ${hook}.${method}() is missing`);
          return await api[method](value);
        }, { hook: capture.hook, method, value });
        const after = await browser.postflightOrigin();
        if (after) throw new Error(after);
        evidence.transcript.push({ step: evidence.transcript.length + 1, at: new Date().toISOString(), tool: `adapter.${method}`, input: { value }, result: JSON.stringify(result) ?? "void" });
        return result;
      };
      await invoke("reset");
      await invoke("setSeed", capture.seed);
      await invoke("configure", { ...capture.setup, ...scenario.caseVariables });
      for (let frame = 0; frame < schedule.length; frame++) {
        check();
        const { label, timeSeconds } = schedule[frame];
        const delta = timeSeconds - (schedule[frame - 1]?.timeSeconds ?? 0);
        if (delta > 0) await invoke("advance", delta);
        await invoke("waitUntilStable");
        await browser.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (capture.rendererPattern) {
          const renderer = await browser.page.evaluate(() => {
            const canvas = document.querySelector("canvas");
            const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
            if (!gl) throw new Error("Renderer check requires a WebGL canvas");
            const debug = gl.getExtension("WEBGL_debug_renderer_info");
            return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
          });
          if (!new RegExp(capture.rendererPattern).test(renderer)) throw new Error(`Renderer ${renderer} does not match ${capture.rendererPattern}`);
          writeJson(path.join(passDir, "renderer.json"), { renderer });
        }
        const shot = await browser.screenshot(label, false);
        const file = path.join(passDir, shot.relPath);
        frames.push(file);
        evidence.screenshots.push({ path: `${passName}/${shot.relPath}`, label: pass ? `${passName}/${label}` : label, timeSeconds, step: evidence.transcript.length });
        const image = await inspectImage(file); images.push(image);
        if (capture.minimumEntropy !== undefined) evidence.captureChecks!.push({ name: `${passName}/${label}/minimumEntropy`, pass: image.entropy >= capture.minimumEntropy, actual: image.entropy, expected: capture.minimumEntropy });
        if (capture.minimumStdev !== undefined) evidence.captureChecks!.push({ name: `${passName}/${label}/minimumStdev`, pass: image.stdev >= capture.minimumStdev, actual: image.stdev, expected: capture.minimumStdev });
        if (capture.imageHealth) {
          const health = await inspectImage(file, capture.imageHealth);
          images[images.length - 1] = { ...image, health };
          evidence.captureChecks!.push(...metricChecks(health, capture.imageHealth.metrics).map(check => ({ ...check, name: `${passName}/${label}/imageHealth/${check.name}` })));
        }
        const values = Object.keys(capture.metrics).length ? await invoke("getMetrics") : null;
        metrics.push(values);
        evidence.captureChecks!.push(...metricChecks(values, capture.metrics).map(check => ({ ...check, name: `${passName}/${label}/${check.name}` })));
        if (frame) {
          const diff = await compareImages(frames[frame - 1], file, capture.movementChannelTolerance, capture.movementCrop);
          if (capture.minimumMovement !== undefined) evidence.captureChecks!.push({ name: `${passName}/${label}/minimumMovement`, pass: diff.changedPixelRatio >= capture.minimumMovement, actual: diff.changedPixelRatio, expected: capture.minimumMovement });
          if (capture.maximumMovement !== undefined) evidence.captureChecks!.push({ name: `${passName}/${label}/maximumMovement`, pass: diff.changedPixelRatio <= capture.maximumMovement, actual: diff.changedPixelRatio, expected: capture.maximumMovement });
          if (capture.rejectDuplicateFrames) evidence.captureChecks!.push({ name: `${passName}/${label}/distinctTemporalFrame`, pass: diff.changedPixelRatio > 0, actual: diff.changedPixelRatio, expected: "> 0 at movementChannelTolerance" });
        }
      }
      await browser.stop(); session = undefined;
      const diagnostics = readDiagnostics(passDir, config.browser.diagnostics);
      evidence.diagnostics!.push(...diagnostics.diagnostics);
      evidence.captureChecks!.push(...diagnostics.checks.map(check => ({ ...check, name: `${passName}/${check.name}` })));
      if (frames.length > 1) {
        const sheet = path.join(passDir, "contact-sheet.png"); await contactSheet(frames, sheet);
        evidence.screenshots.push({ path: `${passName}/contact-sheet.png`, label: pass ? `${passName}/contact-sheet` : "contact-sheet", step: evidence.transcript.length });
      }
      if (pass) {
        for (let frame = 0; frame < frames.length; frame++) {
          const diff = await compareImages(passes[0].frames[frame], frames[frame], capture.channelTolerance);
          fs.writeFileSync(path.join(passDir, `difference-${frame + 1}.png`), diff.difference);
          evidence.captureChecks!.push({ name: `${passName}/${schedule[frame].label}/repeatability`, pass: diff.changedPixelRatio <= capture.maximumChangedPixelRatio, actual: diff.changedPixelRatio, expected: capture.maximumChangedPixelRatio });
        }
        evidence.captureChecks!.push({ name: `${passName}/metricsRepeatability`, pass: stableJson(passes[0].metrics) === stableJson(metrics) });
      }
    }
  };
  let task: Promise<void> | undefined;
  try {
    throwIfCancelled();
    task = collect();
    await Promise.race([task, aborted]);
    const failed = evidence.captureChecks!.filter(check => !check.pass);
    evidence.observations = ["Instrumented evidence: reset, seed, setup, stability and metrics are supplied by the project adapter.", `${evidence.captureChecks!.length} deterministic checks; ${failed.length} failed.`, ...failed.map(check => `${check.name}: ${JSON.stringify(check)}`)];
    evidence.summary = `Captured ${capture.passes} independent passes of ${schedule.length} frames; ${failed.length} check failures.`;
    return evidence;
  } catch (error) {
    evidence.outcome = "agent_error";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.summary = evidence.error;
    throw error;
  } finally {
    stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await session?.stop();
    await task?.catch(() => {});
    await session?.stop();
    evidence.finishedAt = new Date().toISOString(); evidence.durationMs = Date.now() - Date.parse(startedAt);
    writeJson(path.join(directory, "capture.json"), { schedule, checks: evidence.captureChecks, passes: passes.map(p => ({ ...p, frames: p.frames.map(f => path.relative(directory, f)) })) });
    writeJson(path.join(directory, "evidence.json"), evidence);
  }
}
