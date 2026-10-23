import fs from "node:fs/promises";
import path from "node:path";
import { hash } from "./media.mjs";

async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path.join(directory, entry.name), name)));
    else if (entry.isFile()) files.push(name);
    else throw Error(`Unexpected non-file in render assets: ${name}`);
  }
  return files.sort();
}

export async function renderInputs(root) {
  const here = path.join(root, "video/marketing");
  const sources = [
    ...(await filesIn(path.join(here, "src"), "video/marketing/src")),
    ...[
      "render.mjs",
      "release.mjs",
      "terrain.mjs",
      "media.mjs",
      "evidence.mjs",
      "workflow.mjs",
      "improvement/snapshot.mjs",
      "package.json",
      "package-lock.json",
      "toolchain.json",
      "assets/InterVariable.woff2",
    ].map((name) => `video/marketing/${name}`),
    "pnpm-lock.yaml",
    "docs/marketing/hill-climbing.svg",
  ].sort();
  const content = [];
  for (const file of sources) content.push([file, hash(await fs.readFile(path.join(root, file)))]);
  const output = path.join(root, ".agent-eval/marketing-video");
  return {
    compositionSha256: hash(JSON.stringify(content)),
    evidenceSha256: hash(await fs.readFile(path.join(output, "evidence.json"))),
    workflowSha256: hash(await fs.readFile(path.join(output, "workflow.json"))),
  };
}

export async function sealExport(directory, expected) {
  const files = {};
  for (const file of await filesIn(directory)) {
    if (file === "render.json")
      throw Error("A render receipt already exists in this staging directory.");
    files[file] = hash(await fs.readFile(path.join(directory, file)));
  }
  for (const name of ["video.mp4", "captions.vtt", "poster.png", "stills/1.png"])
    if (!files[name]) throw Error(`Incomplete export: missing ${name}`);
  const receipt = { version: 1, ...expected, files };
  await fs.writeFile(path.join(directory, "render.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export async function verifyExport(directory, expected) {
  const receipt = JSON.parse(await fs.readFile(path.join(directory, "render.json"), "utf8"));
  if (receipt.version !== 1 || !receipt.files) throw Error(`Invalid render receipt: ${directory}`);
  for (const [key, value] of Object.entries(expected))
    if (receipt[key] !== value)
      throw Error(`Stale export ${directory}: ${key} changed. Render it again before publishing.`);
  for (const file of ["video.mp4", "captions.vtt", "poster.png", "stills/1.png"])
    if (!receipt.files[file]) throw Error(`Render receipt is missing ${file}`);
  const actual = (await filesIn(directory)).filter((file) => file !== "render.json");
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(receipt.files).sort()))
    throw Error(`Render asset list changed: ${directory}`);
  for (const file of actual)
    if (hash(await fs.readFile(path.join(directory, file))) !== receipt.files[file])
      throw Error(`Render asset changed: ${directory}/${file}`);
  return receipt;
}

// Readers resolve one immutable directory, so video, captions and poster switch together.
export async function pointToRelease(link, directory) {
  await fs.mkdir(path.dirname(link), { recursive: true });
  const temporary = `${link}.partial-${process.pid}`;
  await fs.symlink(path.relative(path.dirname(link), directory), temporary, "dir");
  try {
    await fs.rename(temporary, link);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function publishExport(output, name, directory, expected) {
  await verifyExport(directory, expected);
  await pointToRelease(path.join(output, "exports", name), directory);
}
