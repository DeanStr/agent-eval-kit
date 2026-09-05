import crypto from "node:crypto";
import fs from "node:fs";
import type { ArtifactReceipt } from "./types.js";

export function inputFileReceipt(file: string): ArtifactReceipt {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 ** 3) throw new Error(`Input file must be a regular file <= 1 GiB: ${file}`);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > 1024 ** 3) throw new Error(`Input file grew beyond 1 GiB: ${file}`);
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return { bytes, sha256: hash.digest("hex") };
}

