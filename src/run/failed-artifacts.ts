import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertArtifactIntegrity } from "../integrity.js";
import { sha256, stableJson } from "../io.js";
import type { RunReceipt } from "../types.js";
import { loadRunState } from "./state.js";

const serverLogs = ["lifecycle/start.stdout.log", "lifecycle/start.stderr.log"];
const derivedReports = [
  "report.json",
  "report.html",
  "manual-checklist.md",
  "adjudication-checklist.md",
];

function prefixHash(file: string, bytes: number): string {
  const descriptor = fs.openSync(file, "r");
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = bytes;
    while (remaining > 0) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!read) throw new Error(`Indexed server log was truncated: ${file}`);
      hash.update(buffer.subarray(0, read));
      remaining -= read;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Verify immutable evidence; partial derived reports remain untrusted diagnostics. */
export function verifyFailedRunArtifacts(runDir: string, current: RunReceipt) {
  const index = assertArtifactIntegrity(runDir, {
    require: true,
    allowUnindexed: true,
    allowChangedPaths: ["receipt.json", ...serverLogs, ...derivedReports],
  })!;
  for (const entry of index.entries.filter((entry) => derivedReports.includes(entry.path))) {
    const file = path.join(runDir, entry.path);
    if (!fs.lstatSync(file).isFile())
      throw new Error(`Derived report is not a regular file: ${file}`);
  }
  for (const entry of index.entries.filter((entry) => serverLogs.includes(entry.path))) {
    const file = path.join(runDir, entry.path);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      stat.size < entry.bytes ||
      prefixHash(file, entry.bytes) !== entry.sha256
    )
      throw new Error(`Indexed server log changed rather than appended: ${file}`);
  }
  const receiptEntry = index.entries.find((entry) => entry.path === "receipt.json");
  if (!receiptEntry) throw new Error(`Failed run is missing its indexed receipt: ${runDir}`);
  const file = path.join(runDir, "receipt.json");
  if (!fs.lstatSync(file).isFile()) throw new Error(`Run receipt is not a regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== receiptEntry.bytes || sha256(bytes) !== receiptEntry.sha256) {
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (
      stableJson(receipt) !== stableJson(current) ||
      loadRunState(runDir).inputFingerprint !== current.inputFingerprint
    )
      throw new Error(`Refreshed run receipt does not match current inputs and run state: ${file}`);
  }
  return index;
}
