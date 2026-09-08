import { requireDefined } from "./invariants.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256, stableJson, writeJson } from "./io.js";

export interface ArtifactIndexEntry {
  path: string;
  role: "input" | "evidence" | "judgement" | "report" | "review" | "receipt" | "artifact";
  bytes: number;
  sha256: string;
}

export interface ArtifactIndex {
  schemaVersion: 1;
  generatedAt: string;
  algorithm: "sha256";
  exclusions: string[];
  entries: ArtifactIndexEntry[];
  rootSha256: string;
}

export interface IntegrityVerification {
  ok: boolean;
  index?: ArtifactIndex;
  errors: string[];
}

export interface IntegrityOptions {
  /** A separately anchored checkpoint; leaves the run's own index authoritative for execution. */
  index?: ArtifactIndex;
  require?: boolean;
  allowUnindexed?: boolean | ((relativePath: string) => boolean);
  allowChangedRoles?: ArtifactIndexEntry["role"][];
  /** Exact indexed paths permitted to differ during a recoverable transaction. */
  allowChangedPaths?: string[];
}

export function artifactIndexRoot(
  index: Omit<ArtifactIndex, "rootSha256"> | ArtifactIndex,
): string {
  const { rootSha256: _rootSha256, ...payload } = index as ArtifactIndex;
  return sha256(stableJson(payload));
}

const INDEX_FILE = "artifact-index.json";
const excludedRoots = new Set([
  INDEX_FILE,
  "manual-results.json",
  ".run.lock",
  ".run.lock-acquisition",
  "run-state.json",
  "run.log",
]);
const excludedDirectories = new Set(["comparisons", ".aek-report-update.tmp-active"]);
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const atomicTemporaryFile = new RegExp(`\\.tmp-\\d+-${UUID_PATTERN}$`, "i");
const initializationTemporaryFile = new RegExp(`^\\.aek-init-\\d+-${UUID_PATTERN}\\.tmp$`, "i");

function portable(relative: string): string {
  return relative.split(path.sep).join("/");
}

function included(relative: string, directory: boolean): boolean {
  const parts = portable(relative).split("/");
  if (parts.length === 1 && excludedRoots.has(requireDefined(parts[0], "parts[0]"))) return false;
  if (excludedDirectories.has(requireDefined(parts[0], "parts[0]"))) return false;
  if (directory) return true;
  const name = parts.at(-1)!;
  return !atomicTemporaryFile.test(name) && !initializationTemporaryFile.test(name);
}

function roleFor(relative: string): ArtifactIndexEntry["role"] {
  const normalized = portable(relative);
  if (normalized === "receipt.json") return "receipt";
  if (
    normalized === "report.json" ||
    normalized === "report.html" ||
    normalized === "manual-checklist.md" ||
    normalized === "adjudication-checklist.md"
  )
    return "report";
  if (
    normalized === "manual-revisions.ndjson" ||
    normalized === "adjudications.ndjson" ||
    normalized.startsWith("adjudication-evidence/")
  )
    return "review";
  if (normalized.startsWith("inputs/")) return "input";
  if (normalized.startsWith("lifecycle/")) return "evidence";
  if (normalized.startsWith(".state/")) return "evidence";
  if (
    normalized.startsWith("areas/") ||
    normalized.includes("/_judge/") ||
    normalized.includes("/graders/")
  )
    return "judgement";
  if (
    /^[^/]+\/(?:evidence\.json|outputs\.json|provider-|browser-|workspace-|screenshots(?:\.json|\/)|observations\.json|prompt\.md|.*-context\.json|\.mcp\.json|scenario-output\.schema\.json|\.storage-state\.candidate\.json)/.test(
      normalized,
    )
  )
    return "evidence";
  return "artifact";
}

function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function collect(runDir: string): ArtifactIndexEntry[] {
  const entries: ArtifactIndexEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = portable(path.relative(runDir, absolute));
      if (!included(relative, entry.isDirectory())) continue;
      if (entry.isSymbolicLink())
        throw new Error(`Artifact index refuses symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Artifact index refuses non-file artifact: ${relative}`);
      const stat = fs.statSync(absolute);
      entries.push({
        path: relative,
        role: roleFor(relative),
        bytes: stat.size,
        sha256: sha256File(absolute),
      });
    }
  };
  visit(runDir);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function validRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

export function createArtifactIndex(
  runDir: string,
  options: { includeRunIndex?: boolean } = {},
): ArtifactIndex {
  const resolved = path.resolve(runDir);
  const entries = collect(resolved);
  if (options.includeRunIndex) {
    const file = path.join(resolved, INDEX_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Run artifact index is not a regular file: ${file}`);
    entries.push({
      path: INDEX_FILE,
      role: "artifact",
      bytes: stat.size,
      sha256: sha256File(file),
    });
    entries.sort((left, right) => left.path.localeCompare(right.path));
  }
  const payload: Omit<ArtifactIndex, "rootSha256"> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    algorithm: "sha256",
    exclusions: [
      ...(options.includeRunIndex ? [] : ["artifact-index.json (self)"]),
      "manual-results.json (editable review input)",
      ".run.lock (exclusive execution lock)",
      "run-state.json and run.log (mutable lifecycle state)",
      "comparisons/ (separately generated reports)",
      "temporary staging files",
    ],
    entries,
  };
  const index: ArtifactIndex = { ...payload, rootSha256: artifactIndexRoot(payload) };
  return index;
}

export function writeArtifactIndex(runDir: string): ArtifactIndex {
  const resolved = path.resolve(runDir);
  const index = createArtifactIndex(resolved);
  writeJson(path.join(resolved, INDEX_FILE), index);
  return index;
}

export function verifyArtifactIndex(
  runDir: string,
  options: IntegrityOptions = {},
): IntegrityVerification {
  const resolved = path.resolve(runDir);
  const file = path.join(resolved, INDEX_FILE);
  if (options.index === undefined && !fs.existsSync(file)) {
    return options.require
      ? { ok: false, errors: [`Missing ${INDEX_FILE} in ${resolved}`] }
      : { ok: true, errors: [] };
  }

  const errors: string[] = [];
  let index: ArtifactIndex;
  try {
    index =
      options.index === undefined
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as ArtifactIndex)
        : options.index;
  } catch (error) {
    return {
      ok: false,
      errors: [`Invalid ${INDEX_FILE}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (
    !index ||
    index.schemaVersion !== 1 ||
    index.algorithm !== "sha256" ||
    !Array.isArray(index.entries)
  ) {
    return { ok: false, index, errors: [`Invalid ${INDEX_FILE} schema`] };
  }
  const paths = new Set<string>();
  const allowedChangedRoles = new Set(options.allowChangedRoles ?? []);
  const allowedChangedPaths = new Set((options.allowChangedPaths ?? []).map(portable));
  for (const entry of index.entries) {
    if (!entry || typeof entry.path !== "string" || !validRelativePath(entry.path)) {
      errors.push(`Invalid artifact path in index: ${String(entry?.path)}`);
      continue;
    }
    if (paths.has(entry.path)) errors.push(`Duplicate artifact path in index: ${entry.path}`);
    paths.add(entry.path);
    const changeAllowed =
      allowedChangedRoles.has(entry.role) || allowedChangedPaths.has(entry.path);
    const absolute = path.join(resolved, ...entry.path.split("/"));
    if (!fs.existsSync(absolute)) {
      if (!changeAllowed) errors.push(`Missing artifact: ${entry.path}`);
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      if (!changeAllowed) errors.push(`Artifact is not a regular file: ${entry.path}`);
      continue;
    }
    if (!changeAllowed) {
      if (entry.bytes !== stat.size) errors.push(`Artifact size changed: ${entry.path}`);
      else if (entry.sha256 !== sha256File(absolute))
        errors.push(`Artifact checksum changed: ${entry.path}`);
    }
  }
  if (index.rootSha256 !== artifactIndexRoot(index))
    errors.push("Artifact index root checksum is invalid");

  try {
    const current = collect(resolved).map((entry) => entry.path);
    for (const artifact of current) {
      if (paths.has(artifact)) continue;
      const allowed =
        options.allowUnindexed === true ||
        allowedChangedPaths.has(artifact) ||
        (typeof options.allowUnindexed === "function" && options.allowUnindexed(artifact));
      if (!allowed) errors.push(`Unindexed artifact: ${artifact}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: errors.length === 0, index, errors };
}

export function assertArtifactIntegrity(
  runDir: string,
  options: IntegrityOptions = {},
): ArtifactIndex | undefined {
  const verification = verifyArtifactIndex(runDir, options);
  if (!verification.ok)
    throw new Error(
      `Artifact integrity verification failed:\n  - ${verification.errors.join("\n  - ")}`,
    );
  return verification.index;
}
