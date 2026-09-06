import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertArtifactIntegrity } from "../integrity.js";
import {
  isPortablePathComponent,
  isWithin,
  prospectiveRealPath,
  sha256,
  stableJson,
  writeJson,
} from "../io.js";
import { loadRunState } from "../run/state.js";
import type { EvalConfig, RunReceipt } from "../types.js";

const nameSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .refine(isPortablePathComponent);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
  .object({
    version: z.literal(1),
    name: nameSchema,
    reviewer: z.string().trim().min(1),
    promotedAt: z.string(),
    sourceRun: z.string().min(1),
    sourceArtifactRoot: hash,
    entries: z.record(
      z.string().min(1),
      z.object({ sha256: hash, bytes: z.number().int().positive() }).strict(),
    ),
  })
  .strict();
function referenceRoot(config: EvalConfig, name: string) {
  nameSchema.parse(name);
  if (typeof config.paths.references !== "string" || !config.paths.references.trim())
    throw new Error(
      "Resolved config is missing paths.references; reload the project config before using text references",
    );
  const root = path.resolve(config.paths.references);
  if (!isWithin(path.resolve(config.project.root), root))
    throw new Error("Text reference storage must stay within project.root");
  const directory = path.join(root, name);
  if (!isWithin(fs.realpathSync(config.project.root), prospectiveRealPath(directory)))
    throw new Error("Text reference storage must stay within project.root, including symlinks");
  return directory;
}
function contained(config: EvalConfig, file: string) {
  const actual = fs.realpathSync(file);
  if (!isWithin(fs.realpathSync(config.project.root), actual))
    throw new Error("Text reference storage must stay within project.root, including symlinks");
  return actual;
}

export function loadTextReference(config: EvalConfig, name: string, snapshot?: string) {
  const root = referenceRoot(config, name);
  const id =
    snapshot === undefined
      ? z
          .object({ snapshot: hash })
          .strict()
          .parse(
            JSON.parse(fs.readFileSync(contained(config, path.join(root, "current.json")), "utf8")),
          ).snapshot
      : hash.parse(snapshot);
  const directory = contained(config, path.join(root, id));
  const bytes = fs.readFileSync(contained(config, path.join(directory, "manifest.json")));
  if (sha256(bytes) !== id)
    throw new Error(`Text reference manifest checksum changed: ${name}/${id}`);
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.name !== name) throw new Error("Text reference name does not match its manifest");
  return { directory, snapshot: id, manifest };
}

export function resolveTextReference(
  config: EvalConfig,
  source: { reference: string; key: string; snapshot?: string | undefined },
): string {
  const saved = loadTextReference(config, source.reference, source.snapshot);
  const entry = Object.hasOwn(saved.manifest.entries, source.key)
    ? saved.manifest.entries[source.key]
    : undefined;
  if (!entry) throw new Error(`Unknown text reference key ${source.reference}/${source.key}`);
  const file = contained(config, path.join(saved.directory, `${sha256(source.key)}.txt`));
  const bytes = fs.readFileSync(file);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw new Error(`Text reference content checksum changed: ${source.key}`);
  return file;
}

/** Promotion copies sealed candidate bytes, never current working files. */
export function promoteTextReference(options: {
  config: EvalConfig;
  runDir: string;
  name: string;
  reviewer: string;
}) {
  const { config, name, reviewer } = options;
  if (!reviewer.trim()) throw new Error("Text reference promotion requires a reviewer");
  const runDir = path.resolve(options.runDir);
  const index = assertArtifactIntegrity(runDir, { require: true })!;
  if (loadRunState(runDir).status !== "complete")
    throw new Error("Text reference promotion requires a complete run");
  const receipt = JSON.parse(
    fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"),
  ) as RunReceipt;
  const entries = receipt.inputs.textCandidates;
  if (!entries || !Object.keys(entries).length)
    throw new Error("Run has no candidate text snapshots to promote");
  const root = referenceRoot(config, name);
  fs.mkdirSync(root, { recursive: true });
  contained(config, root);
  const lock = path.join(root, ".promote.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
    throw new Error(
      `Text reference promotion is locked: ${lock}. Retry after the other promotion finishes; remove a stale lock only after confirming no publisher is active.`,
      { cause: error },
    );
  }
  const staged = path.join(root, `.stage-${randomUUID()}`);
  try {
    fs.mkdirSync(staged);
    for (const [key, entry] of Object.entries(entries)) {
      const bytes = fs.readFileSync(
        path.join(runDir, "inputs/textCandidates", `${sha256(key)}.txt`),
      );
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
        throw new Error(`Candidate snapshot checksum changed: ${key}`);
      fs.writeFileSync(path.join(staged, `${sha256(key)}.txt`), bytes, { flag: "wx" });
    }
    const manifest = manifestSchema.parse({
      version: 1,
      name,
      reviewer,
      promotedAt: new Date().toISOString(),
      sourceRun: receipt.inputFingerprint,
      sourceArtifactRoot: index.rootSha256,
      entries,
    });
    const bytes = Buffer.from(`${stableJson(manifest)}\n`),
      snapshot = sha256(bytes);
    fs.writeFileSync(path.join(staged, "manifest.json"), bytes, { flag: "wx" });
    const destination = path.join(root, snapshot);
    fs.renameSync(staged, destination);
    writeJson(path.join(root, "current.json"), { snapshot });
    return { directory: destination, snapshot, keys: Object.keys(entries) };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}

export function listTextReferences(config: EvalConfig) {
  const root = path.dirname(referenceRoot(config, "placeholder"));
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, ...loadTextReference(config, entry.name) }));
}
