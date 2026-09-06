import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { grokAuthPath } from "./providers/grok.js";
import type { ProviderId } from "./types.js";
import { NATIVE_WINDOWS_ERROR } from "./platform.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional capability checks are reported but do not make doctor fail. */
  required: boolean;
}

export interface DoctorOptions {
  /** Omit to discover all real providers and require at least one healthy one. */
  providers?: ProviderId[];
  requireBrowser?: boolean;
}

function probe(command: string, args: string[], timeout = 15_000) {
  return spawnSync(command, args, { encoding: "utf8", timeout, env: process.env });
}

export function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  return major > 20 || (major === 20 && minor >= 19);
}

export function doctor(options: DoctorOptions = {}): DoctorCheck[] {
  if (process.platform === "win32") {
    return [
      { name: "evaluation platform", ok: false, detail: NATIVE_WINDOWS_ERROR, required: true },
    ];
  }
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "node",
    ok: supportedNodeVersion(process.versions.node),
    detail: process.version,
    required: true,
  });
  const browser = chromium.executablePath();
  const browserInstalled = fs.existsSync(browser);
  checks.push({
    name: "playwright chromium",
    ok: browserInstalled,
    detail: browserInstalled
      ? browser
      : `not installed at ${browser}; run \`pnpm exec playwright install chromium\``,
    required: options.requireBrowser === true,
  });

  const providers = options.providers ?? ["codex", "claude", "grok"];
  const requireEveryProvider = options.providers !== undefined;
  const healthyProviders: ProviderId[] = [];
  for (const provider of providers) {
    if (provider === "mock") continue;
    let healthy = true;
    const version = probe(provider, ["--version"]);
    const installed = !version.error && version.status === 0;
    healthy &&= installed;
    checks.push({
      name: `${provider} binary`,
      ok: installed,
      detail: installed
        ? (version.stdout || version.stderr).trim().split("\n", 1).join("")
        : (version.error?.message ?? `exit ${version.status}`),
      required: requireEveryProvider,
    });
    if (!installed) continue;
    if (provider === "codex") {
      const auth = probe("codex", ["login", "status"]);
      const ok = auth.status === 0 && /ChatGPT/i.test(auth.stdout + auth.stderr);
      healthy &&= ok;
      checks.push({
        name: "codex subscription auth",
        ok,
        detail: (auth.stdout + auth.stderr).trim(),
        required: requireEveryProvider,
      });
    } else if (provider === "claude") {
      const auth = probe("claude", ["auth", "status", "--json"]);
      let parsed: Record<string, unknown> = {};
      let parseError: string | undefined;
      try {
        parsed = JSON.parse(auth.stdout);
      } catch (error) {
        parseError = `invalid JSON from claude auth status: ${error instanceof Error ? error.message : String(error)}`;
      }
      const ok = auth.status === 0 && parsed.loggedIn === true && parsed.authMethod === "claude.ai";
      healthy &&= ok;
      checks.push({
        name: "claude subscription auth",
        ok,
        detail: parsed.loggedIn
          ? `${parsed.authMethod}${parsed.subscriptionType ? ` (${parsed.subscriptionType})` : ""}`
          : (parseError ?? (auth.stdout + auth.stderr).trim()),
        required: requireEveryProvider,
      });
    } else {
      const inspect = probe("grok", ["inspect", "--json"]);
      const profileOk = inspect.status === 0;
      healthy &&= profileOk;
      checks.push({
        name: "grok local profile",
        ok: profileOk,
        detail: profileOk ? "profile loads" : (inspect.stdout + inspect.stderr).trim(),
        required: requireEveryProvider,
      });
      const authFile = grokAuthPath();
      const authenticated = fs.existsSync(authFile) && fs.statSync(authFile).isFile();
      healthy &&= authenticated;
      checks.push({
        name: "grok subscription auth",
        ok: authenticated,
        detail: authenticated ? authFile : `not found at ${authFile}; run \`grok login\``,
        required: requireEveryProvider,
      });
    }
    if (healthy) healthyProviders.push(provider);
  }
  if (!requireEveryProvider) {
    checks.push({
      name: "supported subscription provider",
      ok: healthyProviders.length > 0,
      detail: healthyProviders.length
        ? `healthy: ${healthyProviders.join(", ")}`
        : "none of codex, claude, or grok is both installed and ready",
      required: true,
    });
  }
  return checks;
}
