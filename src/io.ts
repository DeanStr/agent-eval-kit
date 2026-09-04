import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeJson(file: string, value: unknown, options: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    fs.renameSync(temporary, file);
    if (options.mode !== undefined) fs.chmodSync(file, options.mode);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function stableJson(value: unknown): string {
  const active = new WeakSet<object>();
  const sort = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (active.has(item)) throw new TypeError("Cannot serialize a cyclic value");
    active.add(item);
    const sorted = Array.isArray(item)
      ? item.map(sort)
      : Object.fromEntries(
          Object.keys(item as Record<string, unknown>)
            .sort()
            .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
        );
    active.delete(item);
    return sorted;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function readNdjson<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as T];
      } catch (error) {
        throw new Error(
          `Invalid NDJSON in ${file} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

export function safeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  if (normalized.length <= 100) return normalized;
  const digest = sha256(value).slice(0, 12);
  return `${normalized.slice(0, 87)}-${digest}`;
}

/** Whether a validated identifier is safe as one path component on POSIX and Windows. */
export function isPortablePathComponent(value: string): boolean {
  // Windows strips terminal dots and treats these basenames as devices even
  // when an extension is present (for example, CON.json).
  return !value.endsWith(".") &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}

export function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Atomically reserve a unique timestamp-named child directory. */
export function createTimestampedDirectory(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const base = path.join(root, timestampId());
  for (let suffix = 0; ; suffix += 1) {
    const directory = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      // Deliberately non-recursive: mkdir is the cross-process reservation.
      fs.mkdirSync(directory);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function copyFileChecked(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

/** Resolve existing ancestor symlinks while preserving a not-yet-created suffix. */
export function prospectiveRealPath(target: string): string {
  const unresolved: string[] = [];
  let existing = path.resolve(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    unresolved.unshift(path.basename(existing));
    existing = parent;
  }
  const resolvedExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  return path.join(resolvedExisting, ...unresolved);
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
