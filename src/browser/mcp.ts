#!/usr/bin/env node
import { registerOutputTool } from "../workflow.js";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserSession } from "./session.js";
import { OriginBoundaryError } from "./interaction-context.js";
import {
  browserActionResultIsError,
  type BrowserMcpContext,
  type BrowserResultState,
} from "./context.js";
import type { ScreenshotRef, TranscriptEntry } from "../types.js";
import { writeJson } from "../io.js";

const contextFile = process.argv[2];
if (!contextFile) {
  console.error("Usage: aek-browser-mcp <browser-context.json>");
  process.exit(2);
}

const context = JSON.parse(fs.readFileSync(path.resolve(contextFile), "utf8")) as BrowserMcpContext;
fs.mkdirSync(context.evidenceDir, { recursive: true });
const transcriptFile = path.join(context.evidenceDir, "browser-transcript.ndjson");
const observationsFile = path.join(context.evidenceDir, "observations.json");
const screenshotsFile = path.join(context.evidenceDir, "screenshots.json");
const resultFile = path.join(context.evidenceDir, "browser-result.json");

let browser: BrowserSession | undefined;
let activePersona = context.persona ?? "anonymous";
const personaSessions = new Map<string, BrowserSession>();
let step = 0;
let lastShotUrl: string | undefined;
const observations: string[] = [];
const screenshots: ScreenshotRef[] = [];
let authenticationExpected = context.expectAuthenticated === true;
let loggedOutStreak = 0;
let sessionLost: string | undefined;

const clip = (text: string, max = 4_000) =>
  text.length > max ? `${text.slice(0, max)}… (truncated)` : text;

function isLoginWall(url: string): boolean {
  try {
    const parsed = new URL(url);
    const routes = [
      parsed.pathname,
      parsed.hash.startsWith("#/") ? parsed.hash.slice(1).split("?", 1).join("") : "",
    ];
    const routeSegments = routes.map((route) =>
      route
        .split("/")
        .filter(Boolean)
        .map((segment) => {
          try {
            return decodeURIComponent(segment).toLowerCase();
          } catch {
            return segment.toLowerCase();
          }
        }),
    );
    const segments = routeSegments.flat();
    const loginSegments = new Set(["login", "log-in", "log_in", "signin", "sign-in", "sign_in"]);
    if (segments.some((segment) => loginSegments.has(segment))) return true;
    if (
      routeSegments.some(
        (route) => route.length === 1 && (route[0] === "auth" || route[0] === "authenticate"),
      )
    )
      return true;
    if (
      routeSegments.some(
        (route) => route.at(-1) === "new" && ["session", "sessions"].includes(route.at(-2) ?? ""),
      )
    )
      return true;
    const expiry = [parsed.searchParams.get("reason"), parsed.searchParams.get("error")]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase().replace(/[^a-z]/g, ""));
    return expiry.some((value) =>
      ["sessionexpired", "loginrequired", "authenticationrequired", "unauthorized"].includes(value),
    );
  } catch {
    return false;
  }
}

function record(entry: TranscriptEntry): void {
  fs.appendFileSync(transcriptFile, `${JSON.stringify({ ...entry, persona: activePersona })}\n`);
}

async function getBrowser(): Promise<BrowserSession> {
  if (browser) return browser;
  const personaState = context.personas?.[activePersona];
  if (
    context.personas &&
    activePersona !== "anonymous" &&
    (!personaState?.storageStatePath || !fs.existsSync(personaState.storageStatePath))
  ) {
    sessionLost = `No saved browser session for persona ${activePersona}. Run aek auth --persona ${activePersona}.`;
    throw new Error(sessionLost);
  }
  const started = new BrowserSession(
    context.evidenceDir,
    context.headless,
    context.targetUrl,
    context.personas ? context.personas[activePersona]?.storageStatePath : context.storageStatePath,
    context.allowedOrigins,
    context.viewport,
    context.actionTimeoutMs,
    "same-origin",
    {
      lossless: context.screenshotFormat === "png",
      ...(context.personas
        ? { namespace: Object.keys(context.personas).indexOf(activePersona) + 1 }
        : {}),
    },
  );
  await started.start();
  browser = started;
  personaSessions.set(activePersona, browser);
  return browser;
}

async function autoCapture(tool: string): Promise<void> {
  if (!browser || !["navigate", "click", "press"].includes(tool)) return;
  const url = browser.page?.url();
  if (!url || url === lastShotUrl || !browser.isAllowedUrl(url)) return;
  lastShotUrl = url;
  try {
    const slug = url.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
    const shot = await browser.screenshot(`auto-${slug}`.slice(0, 55), false);
    screenshots.push({
      persona: activePersona,
      path: shot.relPath,
      label: `auto: ${url}`,
      step,
      url,
    });
    writeJson(screenshotsFile, screenshots);
  } catch {
    // Automatic evidence is best-effort; the requested action already worked.
  }
}

// MCP permits overlapping requests; identity and evidence must advance atomically.
let toolQueue: Promise<void> = Promise.resolve();
function serializeTool<T>(action: () => Promise<T>): Promise<T> {
  const result = toolQueue.then(action);
  // A rejected call still reaches its caller; it must not poison later requests.
  toolQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

function callTool(
  tool: string,
  input: Record<string, unknown>,
  action: (session: BrowserSession) => Promise<string>,
) {
  return serializeTool(() => executeTool(tool, input, action));
}

async function executeTool(
  tool: string,
  input: Record<string, unknown>,
  action: (session: BrowserSession) => Promise<string>,
) {
  const blocked = preflight(tool, input);
  if (blocked) return blocked;
  try {
    const session = await getBrowser();
    const originBlock = await session.preflightOrigin();
    if (originBlock) {
      record({
        step,
        at: new Date().toISOString(),
        tool,
        input,
        result: originBlock,
        isError: true,
      });
      return { content: [{ type: "text" as const, text: originBlock }], isError: true };
    }
    let result = await action(session);
    let isError = browserActionResultIsError(result);
    // Every browser action shares one authoritative postflight. Individual
    // methods also check at sensitive points, but native inputs, waits, and
    // other DOM actions can navigate without going through those branches.
    // Recover here before recording success, inspecting authentication state,
    // auto-capturing evidence, or returning control to the caller.
    const postActionOriginBlock = await session.postflightOrigin();
    if (postActionOriginBlock) {
      result = postActionOriginBlock;
      isError = true;
    }
    if (authenticationExpected && !isError) {
      const url = session.page?.url() ?? "";
      const onLoginWall = isLoginWall(url);
      loggedOutStreak = onLoginWall ? loggedOutStreak + 1 : 0;
      if (loggedOutStreak >= 2) {
        sessionLost =
          `the scenario started with saved authentication but remained on a login wall (${url.slice(0, 180)}). ` +
          `The run stopped before logged-out evidence could be mistaken for missing product functionality.`;
        const note = `SESSION LOST: ${sessionLost}`;
        observations.push(note);
        writeJson(observationsFile, observations);
        const state: BrowserResultState = {
          outcome: "blocked",
          summary: sessionLost,
          observations,
          finalUrl: url,
          finishedAt: new Date().toISOString(),
        };
        writeJson(resultFile, state);
        result = `BLOCKED: ${sessionLost}`;
        isError = true;
      }
    }
    record({ step, at: new Date().toISOString(), tool, input, result: clip(result), isError });
    if (!isError) await autoCapture(tool);
    return {
      content: [{ type: "text" as const, text: `${result}\nEvidence step: ${step}` }],
      ...(isError ? { isError: true } : {}),
    };
  } catch (error) {
    let result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    // A navigation can destroy the action's execution context and make the
    // action throw before the normal postflight runs. Contain that page too;
    // an exception must never leave an external document active.
    if (browser) {
      try {
        const originBlock = await browser.postflightOrigin();
        if (originBlock) result = originBlock;
      } catch (originError) {
        result = `ERROR: ${originError instanceof Error ? originError.message : String(originError)}`;
      }
    }
    record({ step, at: new Date().toISOString(), tool, input, result, isError: true });
    return { content: [{ type: "text" as const, text: result }], isError: true };
  }
}

function preflight(tool: string, input: Record<string, unknown>) {
  step += 1;
  if (context.maxToolCalls !== undefined && step > context.maxToolCalls) {
    const result = `ERROR: browser tool-call budget (${context.maxToolCalls}) exhausted. Record what remains unverified and finish the scenario.`;
    record({ step, at: new Date().toISOString(), tool, input, result, isError: true });
    return { content: [{ type: "text" as const, text: result }], isError: true };
  }
  if (sessionLost) {
    const result = `BLOCKED: ${sessionLost}`;
    record({ step, at: new Date().toISOString(), tool, input, result, isError: true });
    return { content: [{ type: "text" as const, text: result }], isError: true };
  }
  return undefined;
}

const server = new McpServer({ name: "agent-eval-browser", version: "0.1.0" });

server.registerTool(
  "switch_persona",
  {
    description:
      "Switch to a declared saved persona in an isolated browser context, or anonymous. Old element refs become invalid. Navigate to the desired page after switching.",
    inputSchema: { persona: z.string().min(1) },
  },
  ({ persona }) =>
    serializeTool(async () => {
      const input = { persona };
      const blocked = preflight("switch_persona", input);
      if (blocked) return blocked;
      try {
        if (!context.personas || !Object.hasOwn(context.personas, persona))
          throw new Error(`Undeclared persona ${persona}. Declare it in allowedPersonas.`);
        const state = context.personas[persona];
        if (!state) throw new Error(`Missing declared persona state: ${persona}`);
        if (
          !personaSessions.has(persona) &&
          persona !== "anonymous" &&
          (!state.storageStatePath || !fs.existsSync(state.storageStatePath))
        ) {
          sessionLost = `No saved browser session for persona ${persona}. Run aek auth --persona ${persona} before starting a new run.`;
          throw new Error(sessionLost);
        }
        const from = activePersona;
        if (browser) {
          const boundary = await browser.preflightOrigin();
          if (boundary) {
            sessionLost = boundary;
            throw new Error(boundary);
          }
          if (authenticationExpected && isLoginWall(browser.page?.url() ?? "")) {
            sessionLost = `Saved authentication for persona ${from} reached a login wall. Refresh it with aek auth --persona ${from}; switching personas cannot bypass an expired session.`;
            throw new Error(sessionLost);
          }
        }
        browser?.invalidateReferences();
        const next = personaSessions.get(persona);
        next?.invalidateReferences();
        activePersona = persona;
        browser = next;
        authenticationExpected = persona !== "anonymous";
        loggedOutStreak = 0;
        lastShotUrl = undefined;
        try {
          await getBrowser();
        } catch (error) {
          activePersona = from;
          browser = personaSessions.get(from);
          authenticationExpected = from !== "anonymous";
          throw error;
        }
        const result = `Switched persona from ${from} to ${persona}. Browser contexts are isolated; take a fresh snapshot or navigate.`;
        record({
          step,
          at: new Date().toISOString(),
          tool: "switch_persona",
          input: { from, persona },
          result,
        });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        const result = `${sessionLost ? "BLOCKED" : "ERROR"}: ${error instanceof Error ? error.message : String(error)}`;
        record({
          step,
          at: new Date().toISOString(),
          tool: "switch_persona",
          input,
          result,
          isError: true,
        });
        return { content: [{ type: "text" as const, text: result }], isError: true };
      }
    }),
);

server.registerTool(
  "navigate",
  {
    description:
      "Open an allowed target URL and return a text snapshot with actionable element refs.",
    inputSchema: { url: z.string().describe("Absolute or target-relative URL") },
  },
  ({ url }) =>
    callTool("navigate", { url }, async (session) => {
      const target = new URL(url, context.targetUrl).toString();
      if (!["http:", "https:"].includes(new URL(target).protocol)) {
        return `BLOCKED: explicit navigation requires an HTTP(S) target URL; received ${target}`;
      }
      if (!session.isAllowedUrl(target)) {
        return `BLOCKED: ${target} is outside allowed origins: ${context.allowedOrigins.join(", ")}`;
      }
      return session.navigate(target);
    }),
);

server.registerTool(
  "snapshot",
  {
    description:
      "Refresh the page outline and short refs. Use after state changes or stale-ref errors.",
    inputSchema: {},
  },
  () => callTool("snapshot", {}, (session) => session.snapshot()),
);

server.registerTool(
  "click",
  {
    description: "Click an element from the latest snapshot by ref, then return the new snapshot.",
    inputSchema: { ref: z.string() },
  },
  ({ ref }) => callTool("click", { ref }, (session) => session.click(ref)),
);

server.registerTool(
  "fill",
  {
    description:
      "Clear and fill an input, textarea, rich editor, or date/time field. For click-to-edit controls, first click explicitly and use the revealed input's fresh ref.",
    inputSchema: { ref: z.string(), text: z.string() },
  },
  ({ ref, text }) => callTool("fill", { ref, text }, (session) => session.fill(ref, text)),
);

server.registerTool(
  "select",
  {
    description: "Choose a visible option from a native or custom dropdown.",
    inputSchema: { ref: z.string(), value: z.string() },
  },
  ({ ref, value }) => callTool("select", { ref, value }, (session) => session.select(ref, value)),
);

server.registerTool(
  "drag",
  {
    description: "Drag one referenced element onto another.",
    inputSchema: { fromRef: z.string(), toRef: z.string() },
  },
  ({ fromRef, toRef }) =>
    callTool("drag", { fromRef, toRef }, (session) => session.drag(fromRef, toRef)),
);

server.registerTool(
  "upload",
  {
    description: `Upload a named, project-configured fixture. Available names: ${Object.keys(context.fixtureFiles).join(", ") || "(none)"}.`,
    inputSchema: { ref: z.string(), fixture: z.string() },
  },
  ({ ref, fixture }) =>
    callTool("upload", { ref, fixture }, async (session) => {
      const file = context.fixtureFiles[fixture];
      if (!file)
        return `ERROR: unknown fixture ${fixture}. Available: ${Object.keys(context.fixtureFiles).join(", ")}`;
      return session.upload(ref, file);
    }),
);

server.registerTool(
  "press",
  {
    description: "Press a keyboard key such as Enter, Escape, or Tab.",
    inputSchema: { key: z.string() },
  },
  ({ key }) => callTool("press", { key }, (session) => session.press(key)),
);

server.registerTool(
  "scroll",
  {
    description: "Scroll the page or a referenced inner scroll container by roughly one viewport.",
    inputSchema: {
      direction: z.enum(["up", "down"]),
      ref: z.string().optional(),
    },
  },
  ({ direction, ref }) =>
    callTool("scroll", { direction, ...(ref ? { ref } : {}) }, (session) =>
      session.scroll(direction, ref),
    ),
);

server.registerTool(
  "wait",
  {
    description: "Wait briefly for asynchronous UI state to settle (maximum 8000ms).",
    inputSchema: { ms: z.number().int().positive() },
  },
  ({ ms }) => callTool("wait", { ms }, (session) => session.wait(ms)),
);

server.registerTool(
  "screenshot",
  {
    description:
      "Save visual evidence and return the image. Capture every meaningful before/after or result state.",
    inputSchema: { label: z.string(), fullPage: z.boolean().default(false) },
  },
  ({ label, fullPage }) =>
    serializeTool(async () => {
      const input = { label, fullPage };
      const blocked = preflight("screenshot", input);
      if (blocked) return blocked;
      try {
        const session = await getBrowser();
        const shot = await session.screenshot(label, fullPage);
        const ref: ScreenshotRef = {
          persona: activePersona,
          path: shot.relPath,
          label,
          step,
          url: session.page?.url(),
        };
        screenshots.push(ref);
        writeJson(screenshotsFile, screenshots);
        const result = `Screenshot saved: ${shot.relPath}`;
        record({ step, at: new Date().toISOString(), tool: "screenshot", input, result });
        return {
          content: [
            { type: "text" as const, text: result },
            {
              type: "image" as const,
              data: shot.base64,
              mimeType: shot.relPath.endsWith(".png") ? "image/png" : "image/jpeg",
            },
          ],
        };
      } catch (error) {
        const result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        record({
          step,
          at: new Date().toISOString(),
          tool: "screenshot",
          input,
          result,
          isError: true,
        });
        return { content: [{ type: "text" as const, text: result }], isError: true };
      }
    }),
);

server.registerTool(
  "observe",
  {
    description: "Record a concise factual observation for the independent judge.",
    inputSchema: { note: z.string().min(1) },
  },
  ({ note }) =>
    serializeTool(async () => {
      const input = { note };
      const blocked = preflight("observe", input);
      if (blocked) return blocked;
      observations.push(note);
      writeJson(observationsFile, observations);
      record({
        step,
        at: new Date().toISOString(),
        tool: "observe",
        input,
        result: "Observation recorded.",
      });
      return { content: [{ type: "text" as const, text: "Observation recorded." }] };
    }),
);

registerOutputTool(server, {
  ...(context.outputs === undefined ? {} : { outputs: context.outputs }),
  directory: context.evidenceDir,
  transcriptFile,
  call: (input, action) => callTool("publish_output", input, async () => action()),
});

server.registerTool(
  "done",
  {
    description: "Finish the scenario with an honest outcome and evidence-grounded summary.",
    inputSchema: {
      outcome: z.enum(["completed", "blocked", "feature_not_found"]),
      summary: z.string().min(1),
    },
  },
  ({ outcome, summary }) =>
    serializeTool(async () => {
      step += 1;
      let finalUrl: string | undefined;
      let originBlock: string | undefined;
      if (browser) {
        try {
          const shot = await browser.screenshot("final-state", false);
          screenshots.push({
            persona: activePersona,
            path: shot.relPath,
            label: "final-state",
            step,
            url: browser.page?.url(),
          });
          writeJson(screenshotsFile, screenshots);
        } catch (error) {
          if (error instanceof OriginBoundaryError) originBlock = error.message;
          // Best-effort terminal state.
        }
        // screenshot() contains an off-origin page before it fails, so record
        // the safe URL to which the browser was returned rather than the
        // external URL that triggered the boundary.
        finalUrl = browser.page?.url();
        if (authenticationExpected && !sessionLost && finalUrl && isLoginWall(finalUrl)) {
          sessionLost =
            `the scenario started with saved authentication but finished on a login wall (${finalUrl.slice(0, 180)}). ` +
            `The run stopped before logged-out evidence could be mistaken for missing product functionality.`;
          observations.push(`SESSION LOST: ${sessionLost}`);
          writeJson(observationsFile, observations);
        }
        if (
          !context.personas &&
          context.storageStateCandidatePath &&
          !sessionLost &&
          !originBlock
        ) {
          await browser.saveStorageState(context.storageStateCandidatePath);
        }
      }
      if (context.personas && !sessionLost && !originBlock) {
        for (const [persona, session] of personaSessions) {
          const boundary = await session.preflightOrigin();
          if (boundary) {
            originBlock = boundary;
            break;
          }
          if (persona !== "anonymous" && isLoginWall(session.page?.url() ?? "")) {
            sessionLost = `Saved authentication for persona ${persona} finished on a login wall. Refresh it with aek auth --persona ${persona}.`;
            break;
          }
        }
      }
      if (context.personas && !sessionLost && !originBlock) {
        for (const [persona, session] of personaSessions) {
          const candidate = context.personas[persona]?.candidatePath;
          if (candidate) await session.saveStorageState(candidate);
        }
      }
      const state: BrowserResultState = {
        outcome: sessionLost || originBlock ? "blocked" : outcome,
        summary: sessionLost ?? originBlock ?? summary,
        observations,
        ...(finalUrl === undefined ? {} : { finalUrl: finalUrl }),
        finishedAt: new Date().toISOString(),
      };
      writeJson(resultFile, state);
      const result = sessionLost
        ? `BLOCKED: ${sessionLost} The scenario was finalized as blocked.`
        : originBlock
          ? `${originBlock} The scenario was finalized as blocked without capturing off-origin evidence.`
          : "Scenario evidence finalized. Return the required structured result now.";
      record({
        step,
        at: new Date().toISOString(),
        tool: "done",
        input: { outcome, summary },
        result,
      });
      return { content: [{ type: "text" as const, text: result }] };
    }),
);

async function shutdown(): Promise<void> {
  await Promise.all(
    [...new Set([...personaSessions.values(), ...(browser ? [browser] : [])])].map((session) =>
      session.stop(),
    ),
  );
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

const transport = new StdioServerTransport();
await server.connect(transport);
