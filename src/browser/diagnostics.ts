import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { writeJson } from "../io.js";
import {
  browserDiagnosticSchema,
  type BrowserDiagnostic,
  type CaptureCheck,
  type DiagnosticPolicy,
} from "../visual/contracts.js";

export function attachDiagnostics(
  page: Page,
  directory: string,
  budget: { count: number },
  sanitize: (value: string) => string = (value) => value,
): void {
  const file = path.join(directory, "browser-diagnostics.ndjson");
  const started = path.join(directory, "browser-diagnostics-started.json");
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(started) && !fs.existsSync(file))
    throw new Error(`Browser diagnostic stream is missing after recording started: ${file}`);
  fs.closeSync(fs.openSync(file, "a"));
  if (!fs.existsSync(started))
    writeJson(started, { schemaVersion: 1, startedAt: new Date().toISOString() });
  const record = (entry: Omit<BrowserDiagnostic, "at">) => {
    budget.count++;
    if (budget.count > 1000) {
      if (budget.count === 1001)
        writeJson(path.join(directory, "browser-diagnostics-overflow.json"), {
          error: "Browser diagnostics exceeded 1000 events across the session",
        });
      return;
    }
    fs.appendFileSync(
      file,
      JSON.stringify({
        ...entry,
        message: sanitize(entry.message).slice(0, 2000),
        ...(entry.url === undefined ? {} : { url: sanitize(entry.url) }),
        at: new Date().toISOString(),
      }) + "\n",
    );
  };
  page.on("console", (message) => {
    if (message.type() === "error")
      record({ kind: "console", message: message.text(), url: message.location().url });
  });
  page.on("pageerror", (error) =>
    record({ kind: "pageerror", message: error.message, url: page.url() }),
  );
  page.on("requestfailed", (request) =>
    record({
      kind: "requestfailed",
      message: request.failure()?.errorText ?? "Request failed",
      url: request.url(),
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      record({
        kind: "http",
        message: `HTTP ${response.status()}`,
        url: response.url(),
        status: response.status(),
      });
  });
}

export function readDiagnostics(
  directory: string,
  policy?: DiagnosticPolicy,
): { diagnostics: BrowserDiagnostic[]; checks: CaptureCheck[] } {
  if (fs.existsSync(path.join(directory, "browser-diagnostics-overflow.json")))
    throw new Error(`Browser diagnostics overflow: ${directory}`);
  const file = path.join(directory, "browser-diagnostics.ndjson");
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(directory, "browser-diagnostics-started.json")))
      throw new Error(`Browser diagnostic stream is missing after recording started: ${file}`);
    return { diagnostics: [], checks: [] };
  }
  const diagnostics: BrowserDiagnostic[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid browser diagnostic JSON: ${file}:${index + 1}`);
    }
    const parsed = browserDiagnosticSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `Invalid browser diagnostic record: ${file}:${index + 1}: ${parsed.error.message}`,
      );
    diagnostics.push(parsed.data);
  }
  if (diagnostics.length > 1000) throw new Error(`Browser diagnostics overflow: ${file}`);
  return {
    diagnostics,
    checks: (policy?.failOn ?? []).map((kind) => {
      const count = diagnostics.filter(
        (entry) =>
          entry.kind === kind &&
          !policy?.ignoreUrls.some((pattern) => entry.url?.includes(pattern)),
      ).length;
      return { name: `browser.${kind}`, pass: count === 0, actual: count, expected: 0 };
    }),
  };
}
