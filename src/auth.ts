import { requireDefined } from "./invariants.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { BrowserSession } from "./browser/session.js";
import { safeName, sha256 } from "./io.js";
import type { EvalConfig } from "./types.js";
import { authenticateEmail } from "./email/authenticate.js";

function personaStorageName(persona: string): string {
  // Keep a short readable prefix for operators, then use the full digest so
  // punctuation replacement and safeName's length cap cannot merge personas.
  return `${safeName(persona).slice(0, 35)}-${sha256(persona)}`;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function personaAuthPath(config: EvalConfig, persona: string): string {
  if (!config.target.url) throw new Error("Browser authentication requires target.url");
  const url = new URL(config.target.url);
  const readableOrigin = safeName(`${url.protocol.slice(0, -1)}-${url.host}`).slice(0, 50);
  const originStorageName = `${readableOrigin}-${sha256(url.origin)}`;
  return path.join(config.paths.auth, originStorageName, `${personaStorageName(persona)}.json`);
}

export async function captureAuth(options: {
  config: EvalConfig;
  persona: string;
  startAt?: string;
  clickText?: string;
  email?: boolean;
}): Promise<string> {
  const { config, persona, clickText } = options;
  if (options.email && (options.startAt || clickText))
    throw new Error("aek auth --email uses the configured flow; omit --at and --click");
  const flow = options.email ? config.emailAuth?.[persona] : undefined;
  if (options.email && !flow)
    throw new Error(`No emailAuth flow configured for persona ${persona}`);
  if (persona === "anonymous")
    throw new Error(
      "anonymous is reserved for unauthenticated browser contexts; capture a named persona instead",
    );
  if (!config.target.url) throw new Error("aek auth requires a web target with target.url");
  const target = personaAuthPath(config, persona);
  const scratch = path.join(config.paths.auth, ".capture", personaStorageName(persona));
  ensurePrivateDirectory(config.paths.auth);
  ensurePrivateDirectory(path.dirname(target));
  ensurePrivateDirectory(scratch);
  const browser = new BrowserSession(
    scratch,
    // Interactive capture always needs a visible window. Automated capture
    // follows the configured mode so `aek auth --click ... --headed` remains
    // observable and debuggable.
    Boolean(clickText || options.email) && config.browser.headless,
    config.target.url,
    undefined,
    config.target.allowedOrigins,
    config.browser.viewport,
    config.browser.actionTimeoutMs,
    "authentication",
    config.browser.readOnlyFrames === undefined
      ? undefined
      : { readOnlyFrames: config.browser.readOnlyFrames },
  );
  await browser.start();
  try {
    if (flow) {
      const mailbox = config.mailboxes?.[flow.mailbox];
      if (!mailbox) throw new Error("Email authentication references a missing mailbox");
      await authenticateEmail({ browser, targetUrl: config.target.url, flow, mailbox });
      await browser.finalizeAuthenticationCapture();
      await browser.saveStorageState(target);
      return target;
    }
    const url = new URL(options.startAt ?? "", config.target.url).toString();
    await browser.navigate(url);
    if (clickText) {
      const snapshot = await browser.snapshot();
      const controls = snapshot.split("\n").filter((line) => /^\[e\d+\]/.test(line));
      const needle = clickText.toLowerCase();
      const label = (line: string) =>
        line
          .replace(/^\[e\d+\] <[^>]*>\s*/, "")
          .trim()
          .toLowerCase();
      let matches = controls.filter((line) => label(line).startsWith(needle));
      if (!matches.length) matches = controls.filter((line) => label(line).includes(needle));
      if (matches.length !== 1) {
        throw new Error(
          matches.length
            ? `${JSON.stringify(clickText)} matched ${matches.length} controls; use a more specific label:\n${matches.slice(0, 10).join("\n")}`
            : `No control matched ${JSON.stringify(clickText)}. Visible controls:\n${controls.slice(0, 25).join("\n")}`,
        );
      }
      const control = requireDefined(matches[0], "unique auth control");
      const ref = requireDefined(
        /^\[(e\d+)\]/.exec(control)?.[1],
        `auth control reference: ${control}`,
      );
      const clickResult = await browser.click(ref);
      const clickFailure = clickResult.split("\n").find((line) => /^(ERROR|BLOCKED):/.test(line));
      if (clickFailure) throw new Error(`Auth capture click failed: ${clickFailure}`);
      await browser.wait(1500);
    } else {
      console.error(`A browser is open at ${url}. Sign in as persona ${JSON.stringify(persona)}.`);
      console.error("Complete magic-link or OAuth navigation in that same browser window.");
      const input = readline.createInterface({ input: process.stdin, output: process.stderr });
      await input.question("Press Enter when the authenticated app is visible... ");
      input.close();
    }
    await browser.finalizeAuthenticationCapture();
    await browser.saveStorageState(target);
    return target;
  } finally {
    await browser.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
