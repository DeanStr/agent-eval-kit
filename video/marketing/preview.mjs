import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export async function preparePreview() {
  const output = path.join(root, ".agent-eval/marketing-video");
  const preview = path.join(output, "preview");
  await fs.mkdir(preview, { recursive: true });
  for (const format of ["landscape", "portrait"]) {
    await fs.copyFile(
      path.join(output, `${format}.mp4`),
      path.join(preview, `${format}.partial.mp4`),
    );
    await fs.rename(
      path.join(preview, `${format}.partial.mp4`),
      path.join(preview, `${format}.mp4`),
    );
    await fs.copyFile(
      path.join(output, `stills/${format}/1.png`),
      path.join(preview, `${format}-poster.png`),
    );
  }
  const link = path.join(root, "docs/marketing/video-output");
  try {
    await fs.symlink("../../.agent-eval/marketing-video/preview", link, "dir");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await fs.realpath(link)) !== preview)
      throw new Error(`Preview path already points elsewhere: ${link}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await preparePreview();
