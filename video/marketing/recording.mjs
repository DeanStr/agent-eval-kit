import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asset = new URL("./assets/recording.json.gz", import.meta.url);
const index = new URL("./assets/recording-index.json", import.meta.url);
const prefix = ".agent-eval/marketing-video/";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function decodeRecording(bytes, expectedHash) {
  if (hash(bytes) !== expectedHash) throw Error("Recording archive checksum mismatch.");
  const archive = JSON.parse(gunzipSync(bytes));
  if (archive.version !== 1 || !Array.isArray(archive.files) || !archive.blobs)
    throw Error("Invalid recording archive.");
  const blobs = new Map();
  for (const [digest, encoded] of Object.entries(archive.blobs)) {
    const content = Buffer.from(encoded, "base64");
    if (hash(content) !== digest) throw Error(`Recording blob checksum mismatch: ${digest}`);
    blobs.set(digest, content);
  }
  const seen = new Set();
  return archive.files.map((file) => {
    if (
      typeof file.path !== "string" ||
      !file.path.startsWith(prefix) ||
      file.path.includes("\\") ||
      path.posix.normalize(file.path) !== file.path ||
      seen.has(file.path)
    )
      throw Error(`Invalid recording path: ${file.path}`);
    seen.add(file.path);
    const content = blobs.get(file.sha256);
    if (!content) throw Error(`Missing recording blob: ${file.path}`);
    return { path: file.path, sha256: file.sha256, content };
  });
}

async function assertNoSymlinks(destination, relative) {
  let current = destination;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw Error(`Refusing recording symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function restoreRecording(destination = root) {
  const metadata = JSON.parse(await fs.readFile(index, "utf8"));
  const files = decodeRecording(await fs.readFile(asset), metadata.sha256);
  const missing = [];
  // Check the entire archive before writing. Existing sessions are never overwritten.
  for (const file of files) {
    await assertNoSymlinks(destination, file.path);
    try {
      if (hash(await fs.readFile(path.join(destination, file.path))) !== file.sha256)
        throw Error(
          `Recording conflicts with ${file.path}. Restore in a clean checkout or retain your current session separately.`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(file);
    }
  }
  for (const file of missing) {
    const target = path.join(destination, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { flag: "wx" });
  }
  return { restored: missing.length, verified: files.length };
}

async function packRecording() {
  const { loadEvidence } = await import("./evidence.mjs");
  const { loadWorkflow } = await import("./workflow.mjs");
  const manifests = [await loadEvidence(), await loadWorkflow()];
  const paths = [
    ...new Set([
      ...manifests.flatMap((manifest) => manifest.sources.map((source) => source.path)),
      `${prefix}evidence.json`,
      `${prefix}workflow.json`,
    ]),
  ].sort();
  const files = [],
    blobs = {};
  for (const file of paths) {
    const content = await fs.readFile(path.join(root, file));
    const digest = hash(content);
    files.push({ path: file, sha256: digest });
    blobs[digest] = content.toString("base64");
  }
  const bytes = gzipSync(JSON.stringify({ version: 1, files, blobs }), { level: 9 });
  decodeRecording(bytes, hash(bytes));
  await fs.writeFile(asset, bytes);
  await fs.writeFile(
    index,
    JSON.stringify(
      {
        version: 1,
        sha256: hash(bytes),
        bytes: bytes.length,
        files: files.length,
        scope:
          "Retained synthetic dashboard and dispatch sessions, source snapshots, reports and browser captures. Restoring replays historical evidence; it does not run a fresh evaluation.",
      },
      null,
      2,
    ) + "\n",
  );
  return { files: files.length, bytes: bytes.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (!["restore", "pack"].includes(action)) throw Error("Usage: node recording.mjs restore|pack");
  console.log(
    JSON.stringify(action === "restore" ? await restoreRecording() : await packRecording()),
  );
}
