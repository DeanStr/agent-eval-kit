import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  retainEvidenceFile,
  inspectEvidenceFile,
  parseCsv,
  inspectZip,
  readEvidenceFile,
  validateEvidenceFiles,
} from "../src/evidence/files.js";

function zip(
  content = Buffer.from("hello"),
  options: {
    descriptor?: "valid" | "missing" | "bad";
    junk?: boolean;
    stored?: boolean;
    name?: Buffer;
    utf8?: boolean;
  } = {},
): Buffer {
  const compressed = Buffer.concat([
      options.stored ? content : deflateRawSync(content),
      ...(options.junk ? [Buffer.from("junk")] : []),
    ]),
    name = options.name ?? Buffer.from("report.txt");
  const method = options.stored ? 0 : 8;
  const flags = (options.descriptor ? 8 : 0) | (options.utf8 ? 0x800 : 0);
  const descriptor = Buffer.alloc(options.descriptor && options.descriptor !== "missing" ? 16 : 0);
  if (descriptor.length) {
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(options.descriptor === "bad" ? 0 : 0x3610a686, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(content.length, 12);
  }
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(flags, 6);
  local.writeUInt32LE(0x3610a686, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(flags, 8);
  central.writeUInt32LE(0x3610a686, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

test("file evidence preserves bytes, provides bounded text, and rejects changed or escaped files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-files-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = retainEvidenceFile({
    directory,
    label: "data",
    filename: "data.json",
    mediaType: "application/json",
    bytes: Buffer.from('{"rows":2}'),
    step: 4,
    persona: "reviewer",
  });
  assert.deepEqual(inspectEvidenceFile(directory, file, "json"), { rows: 2 });
  const transcript = [
    { step: 4, at: "now", tool: "download", input: { label: "data" }, result: "retained" },
  ];
  validateEvidenceFiles([file], transcript);
  validateEvidenceFiles([], []);
  assert.throws(() => validateEvidenceFiles([], transcript), /missing its file metadata/);
  assert.throws(() => validateEvidenceFiles([], [], ["data"]), /missing required file metadata/);
  assert.equal(file.persona, "reviewer");
  assert.equal(file.text?.truncated, false);
  assert.throws(
    // @ts-expect-error JavaScript consumers must also get an actionable error.
    () => inspectEvidenceFile(directory, file, "pdf"),
    /Unsupported evidence file format/,
  );
  assert.throws(() => readEvidenceFile(directory, { ...file, path: "../escape" }), /contained/);
  fs.writeFileSync(path.join(directory, file.path), '{"rows":3}');
  assert.throws(() => inspectEvidenceFile(directory, file, "json"), /hash changed/);
  const long = retainEvidenceFile({
    directory,
    label: "long",
    filename: "long.txt",
    mediaType: "text/plain",
    bytes: Buffer.from("a".repeat(9000)),
    step: 5,
  });
  assert.equal(long.text?.content.length, 8000);
  assert.equal(long.text?.truncated, true);
  assert.throws(
    () =>
      retainEvidenceFile({
        directory,
        label: "invalid-text",
        filename: "bad.txt",
        mediaType: "text/plain",
        bytes: Buffer.from([0xff]),
        step: 6,
      }),
    /encoded data/,
  );
  assert.equal(fs.readdirSync(path.join(directory, "files")).length, 2);
  assert.throws(
    () =>
      retainEvidenceFile({
        directory,
        label: "big",
        filename: "big",
        mediaType: "application/octet-stream",
        bytes: Buffer.alloc(20 * 1024 * 1024 + 1),
        step: 6,
      }),
    /20 MiB/,
  );
});

test("distinct file labels retain identical bytes without normalized path collisions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-file-labels-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("name\nAlice\n");
  const files = ["report", "report-"].map((label) =>
    retainEvidenceFile({
      directory,
      label,
      filename: "report.csv",
      mediaType: "text/csv",
      bytes,
      step: 1,
    }),
  );
  validateEvidenceFiles(files, [], ["report", "report-"]);
  assert.notEqual(files[0]!.path, files[1]!.path);
  for (const file of files) assert.deepEqual(readEvidenceFile(directory, file), bytes);
});

test("CSV inspection understands quoted newlines and fails on malformed rows", () => {
  assert.deepEqual(parseCsv(Buffer.from('name,note\r\nAlice,"line one\nline ""two"""\r\n')), [
    ["name", "note"],
    ["Alice", 'line one\nline "two"'],
  ]);
  assert.throws(() => parseCsv(Buffer.from("name,note\na,b,c")), /column counts/);
  assert.throws(() => parseCsv(Buffer.from('"unfinished')), /Unterminated/);
  assert.throws(() => parseCsv(Buffer.from('"closed"oops')), /Unexpected/);
});

test("ZIP inspection uses the filename encoding flag and rejects invalid UTF-8", () => {
  const cp437 = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]);
  assert.equal(inspectZip(zip(undefined, { name: cp437 }))[0]!.name, "café.txt");
  const utf8 = Buffer.from("café.txt");
  assert.equal(inspectZip(zip(undefined, { name: utf8, utf8: true }))[0]!.name, "café.txt");
  assert.equal(inspectZip(zip(undefined, { name: utf8 }))[0]!.name, "caf├⌐.txt");
  assert.throws(() => inspectZip(zip(undefined, { name: cp437, utf8: true })), /encoded data/);
});

test("ZIP inspection verifies actual decompressed content and CRC without extracting paths", () => {
  const bytes = zip();
  assert.deepEqual(
    inspectZip(bytes).map((entry) => ({ name: entry.name, bytes: entry.bytes })),
    [{ name: "report.txt", bytes: 5 }],
  );
  const damaged = Buffer.from(bytes);
  damaged.writeUInt32LE(0, 30 + 10 + deflateRawSync(Buffer.from("hello")).length + 16);
  assert.throws(() => inspectZip(damaged), /CRC/);
  assert.throws(() => inspectZip(bytes.subarray(0, bytes.length - 1)), /missing/);
  const encrypted = Buffer.from(bytes);
  encrypted.writeUInt16LE(1, 30 + 10 + deflateRawSync(Buffer.from("hello")).length + 8);
  assert.throws(() => inspectZip(encrypted), /encrypted/);
  assert.deepEqual(inspectZip(zip(undefined, { stored: true })), inspectZip(bytes));
  assert.deepEqual(inspectZip(zip(undefined, { descriptor: "valid" })), inspectZip(bytes));
  assert.throws(() => inspectZip(zip(undefined, { descriptor: "missing" })), /data descriptor/);
  assert.throws(() => inspectZip(zip(undefined, { descriptor: "bad" })), /data descriptor/);
  assert.throws(() => inspectZip(zip(undefined, { junk: true })), /trailing data/);
});
