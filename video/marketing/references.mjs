import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash, board, assertToolchain } from "./media.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  await fs.readFile(new URL("./references.json", import.meta.url), "utf8"),
);
const directory = path.join(root, ".agent-eval/marketing-video/references");
await assertToolchain();
await fs.mkdir(directory, { recursive: true });
for (const ref of manifest.references) {
  const file = path.join(directory, `${ref.id}.mp4`);
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(ref.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Cannot download ${ref.id}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== ref.sha256 || bytes.length !== ref.bytes)
      throw new Error(
        `Reference ${ref.id} changed. Review the new film and update references.json explicitly.`,
      );
    await fs.writeFile(file, bytes, { flag: "wx" });
  }
  if (hash(bytes) !== ref.sha256 || bytes.length !== ref.bytes)
    throw new Error(`Reference checksum mismatch: ${file}. Do not silently replace a benchmark.`);
  await fs.writeFile(
    path.join(directory, `${ref.id}-board.png`),
    await board(file, ref.times, ref.id),
  );
  console.log(`Verified and sampled ${ref.title}`);
}
