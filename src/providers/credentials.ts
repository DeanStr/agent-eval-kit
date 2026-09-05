import fs from "node:fs";
import { writeJson } from "../io.js";

/** Copy credentials without settings, and retain provider-written refreshes. */
export function stageCredentials(source: string, destination: string): () => void {
  const resolvedSource = fs.realpathSync(source);
  const original = fs.readFileSync(resolvedSource);
  const mode = fs.statSync(resolvedSource).mode & 0o777;
  fs.writeFileSync(destination, original, { mode });
  return () => {
    if (!fs.existsSync(destination)) return;
    const refreshed = fs.readFileSync(destination);
    if (refreshed.equals(original)) return;
    // A concurrent login or another invocation may already have updated the
    // account. Never replace that newer state with our isolated copy.
    if (!fs.existsSync(source) || fs.realpathSync(source) !== resolvedSource ||
        !fs.readFileSync(resolvedSource).equals(original)) return;
    let value: unknown;
    try {
      value = JSON.parse(refreshed.toString("utf8"));
    } catch {
      // JSON parser errors can include input excerpts containing credentials.
      throw new Error("Provider wrote invalid refreshed credential JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Provider wrote an invalid refreshed credential object");
    }
    writeJson(resolvedSource, value, { mode });
  };
}
