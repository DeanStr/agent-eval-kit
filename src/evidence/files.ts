import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { sha256, safeName } from "../io.js";
import type { EvidenceFile, TranscriptEntry } from "../types.js";

export const MAX_EVIDENCE_FILE_BYTES = 20 * 1024 * 1024;

// ZIP APPNOTE Appendix D: bit 11 selects UTF-8; otherwise use CP437.
// Mapping: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP437.TXT
const cp437High =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function zipFilename(bytes: Buffer, flags: number): string {
  if (flags & 0x800)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return Array.from(bytes, (byte) =>
    byte < 128 ? String.fromCharCode(byte) : cp437High[byte - 128]!,
  ).join("");
}
export const evidenceFileSchema = z
  .object({
    label: z.string().min(1),
    path: z.string().min(1),
    filename: z.string().min(1),
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative().max(MAX_EVIDENCE_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    step: z.number().int().nonnegative(),
    persona: z.string().optional(),
    url: z.string().optional(),
    text: z
      .object({ content: z.string().max(8000), truncated: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

/** Absent collections are valid only when execution did not publish or require files. */
export function validateEvidenceFiles(
  files: EvidenceFile[],
  transcript: TranscriptEntry[],
  requiredLabels: string[] = [],
): void {
  for (const file of files) evidenceFileSchema.parse(file);
  if (
    new Set(files.map((file) => file.label)).size !== files.length ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    throw new Error("Duplicate file evidence labels or paths");
  for (const entry of transcript.filter((entry) => entry.tool === "download" && !entry.isError))
    if (!files.some((file) => file.step === entry.step && file.label === entry.input.label))
      throw new Error(`Successful download at step ${entry.step} is missing its file metadata`);
  for (const entry of transcript.filter(
    (entry) => entry.tool === "authenticate_email" && !entry.isError,
  ))
    if (
      !files.some((file) => file.step === entry.step && file.label === "aek-email-authentication")
    )
      throw new Error(
        `Successful email authentication at step ${entry.step} is missing its file metadata`,
      );
  for (const label of requiredLabels)
    if (!files.some((file) => file.label === label))
      throw new Error(`Completed collector is missing required file metadata: ${label}`);
}

export function containedFile(root: string, relative: string): string {
  if (
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative === ".." ||
    relative.startsWith("../")
  )
    throw new Error(`Evidence file path must be contained and relative: ${relative}`);
  const file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(file).isFile())
    throw new Error(`Evidence file escapes its directory or is not regular: ${relative}`);
  return file;
}

export function readEvidenceFile(root: string, file: EvidenceFile): Buffer {
  evidenceFileSchema.parse(file);
  const resolved = containedFile(root, file.path);
  if (fs.statSync(resolved).size !== file.bytes)
    throw new Error(`Evidence file size changed: ${file.path}`);
  const bytes = fs.readFileSync(resolved);
  if (sha256(bytes) !== file.sha256) throw new Error(`Evidence file hash changed: ${file.path}`);
  return bytes;
}

/** The MIME type is a declared format, not proof that the contents are valid. */
export function retainEvidenceFile(options: {
  directory: string;
  label: string;
  filename: string;
  mediaType: string;
  bytes: Buffer;
  step: number;
  persona?: string;
  url?: string;
}): EvidenceFile {
  if (options.bytes.length > MAX_EVIDENCE_FILE_BYTES)
    throw new Error("Evidence file exceeds 20 MiB");
  const hash = sha256(options.bytes);
  const relative = `files/${safeName(options.label)}-${sha256(options.label).slice(0, 16)}-${hash.slice(0, 16)}`;
  let preview: EvidenceFile["text"];
  if (/^(text\/|application\/(json|xml)(?:;|$))/.test(options.mediaType)) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(options.bytes);
    preview = { content: decoded.slice(0, 8000), truncated: decoded.length > 8000 };
  }
  const file = {
    label: options.label,
    path: relative,
    filename: options.filename,
    mediaType: options.mediaType,
    bytes: options.bytes.length,
    sha256: hash,
    step: options.step,
    ...(options.persona === undefined ? {} : { persona: options.persona }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(preview === undefined ? {} : { text: preview }),
  };
  evidenceFileSchema.parse(file);
  fs.mkdirSync(path.join(options.directory, "files"), { recursive: true });
  fs.writeFileSync(path.join(options.directory, relative), options.bytes, { flag: "wx" });
  return file;
}

/** RFC-style quoted CSV fields, including escaped quotes and embedded newlines. */
export function parseCsv(bytes: Buffer): string[][] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new Error("Invalid quote in CSV field");
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed) throw new Error("Unexpected characters after quoted CSV field");
      field += c;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  if (rows.some((row) => row.length !== rows[0]?.length))
    throw new Error("CSV rows have inconsistent column counts");
  return rows;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect ZIP contents without extracting paths. Unsupported/encrypted archives fail explicitly. */
export function inspectZip(bytes: Buffer): Array<{ name: string; bytes: number; sha256: string }> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP end directory is missing");
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    offset = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 65535 ||
    count > 1000 ||
    offset + size !== end
  )
    throw new Error(
      "Unsupported ZIP layout: require a single disk, non-ZIP64 archive with at most 1000 entries",
    );
  let cursor = offset,
    total = 0;
  const names = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20),
      expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end)
      throw new Error("Truncated ZIP directory");
    const name = zipFilename(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    if (
      !name ||
      names.has(name) ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      name.includes("\0")
    )
      throw new Error("Invalid or duplicate ZIP entry name");
    names.add(name);
    total += expanded;
    if (flags & 1 || ![0, 8].includes(method))
      throw new Error("Unsupported encrypted ZIP or compression method");
    if (
      total > MAX_EVIDENCE_FILE_BYTES ||
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error("Invalid ZIP entry or expanded contents exceed 20 MiB");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      localNameLength !== nameLength ||
      !bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength)) ||
      bytes.readUInt16LE(cursor + 34) !== 0
    )
      throw new Error("ZIP local header disagrees with its directory");
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(cursor + 16) ||
        bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== expanded)
    )
      throw new Error("ZIP local sizes or CRC disagree with its directory");
    if (start + compressed > offset) throw new Error("ZIP entry overlaps directory");
    const payload = bytes.subarray(start, start + compressed);
    let content = payload;
    if (method === 8) {
      const inflated = inflateRawSync(payload, {
        maxOutputLength: Math.max(1, expanded),
        info: true,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.engine.bytesWritten !== compressed)
        throw new Error("ZIP compressed stream contains trailing data");
      content = inflated.buffer;
    }
    if (content.length !== expanded || crc32(content) !== bytes.readUInt32LE(cursor + 16))
      throw new Error("ZIP entry failed size or CRC integrity check");
    let endOfEntry = start + compressed;
    if (flags & 8) {
      if (endOfEntry + 4 <= offset && bytes.readUInt32LE(endOfEntry) === 0x08074b50)
        endOfEntry += 4;
      if (
        endOfEntry + 12 > offset ||
        bytes.readUInt32LE(endOfEntry) !== bytes.readUInt32LE(cursor + 16) ||
        bytes.readUInt32LE(endOfEntry + 4) !== compressed ||
        bytes.readUInt32LE(endOfEntry + 8) !== expanded
      )
        throw new Error("ZIP data descriptor is missing or disagrees with its directory");
      endOfEntry += 12;
    }
    if (ranges.some((range) => local < range.end && endOfEntry > range.start))
      throw new Error("ZIP entries overlap");
    ranges.push({ start: local, end: endOfEntry });
    entries.push({ name, bytes: content.length, sha256: sha256(content) });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) throw new Error("ZIP directory size mismatch");
  return entries;
}

/** Reusable deterministic checker input; compare with independent expected data in a command grader. */
export function inspectEvidenceFile(root: string, file: EvidenceFile, format: "csv"): string[][];
export function inspectEvidenceFile(
  root: string,
  file: EvidenceFile,
  format: "zip",
): ReturnType<typeof inspectZip>;
export function inspectEvidenceFile(
  root: string,
  file: EvidenceFile,
  format: "binary",
): { bytes: number; sha256: string };
export function inspectEvidenceFile(
  root: string,
  file: EvidenceFile,
  format: "binary" | "json" | "csv" | "zip",
): unknown;
export function inspectEvidenceFile(
  root: string,
  file: EvidenceFile,
  format: "binary" | "json" | "csv" | "zip",
): unknown {
  const bytes = readEvidenceFile(root, file);
  switch (format) {
    case "binary":
      return { bytes: bytes.length, sha256: sha256(bytes) };
    case "json":
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    case "csv":
      return parseCsv(bytes);
    case "zip":
      return inspectZip(bytes);
    default:
      throw new Error(`Unsupported evidence file format: ${format}`);
  }
}
