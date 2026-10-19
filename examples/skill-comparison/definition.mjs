import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const relative = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== "." &&
      value !== ".." &&
      !value.startsWith("../"),
    "Use a contained relative path",
  );
const files = z
  .record(relative, z.string().min(1))
  .refine((value) => Object.keys(value).length > 0, "Declare at least one file");
const definitionSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    baseline: id,
    variants: z.record(id, z.string().min(1)).refine((v) => Object.keys(v).length >= 2),
    runner: z.string().min(1),
    tasks: z
      .array(
        z
          .object({
            id,
            // TASK.md is installed separately and is always protected.
            task: z.string().min(1),
            startingState: z.record(relative, z.string().min(1)),
            protected: z.array(relative),
            outputs: z.record(relative, relative).refine((v) => Object.keys(v).length > 0),
            evaluation: z
              .object({
                config: z.string().min(1),
                files,
                controlFiles: z.record(relative, z.array(z.string().min(1)).min(1)).default({}),
                timeoutSeconds: z.number().int().positive().max(3600).default(120),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// Refuse symlinks at every level, including ancestors of a submitted file.
export function readTree(root, relativePath) {
  let current = path.resolve(root);
  relative.parse(relativePath);
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic link: ${current}`);
  }
  const result = {};
  const visit = (file, name) => {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).sort())
        visit(path.join(file, child), `${name}/${child}`);
    } else if (stat.isFile())
      result[name] = { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
    else throw new Error(`Expected regular file or directory: ${file}`);
  };
  visit(current, relativePath);
  if (!Object.keys(result).length) throw new Error(`No files at ${current}`);
  return result;
}

export function install(root, entries) {
  for (const [file, { bytes, mode }] of Object.entries(entries)) {
    relative.parse(file);
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: "wx", mode });
    fs.chmodSync(destination, mode);
  }
}

export const hashes = (entries) =>
  Object.fromEntries(
    Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, { bytes, mode }]) => [file, { sha256: hash(bytes), mode }]),
  );

export function loadDefinition(file) {
  const definition = definitionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!Object.hasOwn(definition.variants, definition.baseline))
    throw new Error("Unknown baseline variant");
  if (new Set(definition.tasks.map((task) => task.id)).size !== definition.tasks.length)
    throw new Error("Task ids must be unique");
  const root = path.dirname(path.resolve(file));
  const read = (source) => fs.readFileSync(path.resolve(root, source));
  const expand = (mapping) => {
    const result = {};
    for (const [destination, source] of Object.entries(mapping)) {
      const absolute = path.resolve(root, source);
      for (const [name, bytes] of Object.entries(
        readTree(path.dirname(absolute), path.basename(absolute)),
      )) {
        const target = destination + name.slice(path.basename(absolute).length);
        if (Object.hasOwn(result, target)) throw new Error(`Duplicate destination: ${target}`);
        result[target] = bytes;
      }
    }
    return result;
  };
  return {
    ...definition,
    runner: path.resolve(root, definition.runner),
    variants: Object.fromEntries(
      Object.entries(definition.variants).map(([id, source]) => [
        id,
        read(source).toString("utf8"),
      ]),
    ),
    tasks: definition.tasks.map((task) => {
      const startingState = expand(task.startingState);
      if (Object.hasOwn(startingState, "TASK.md"))
        throw new Error("Declare TASK.md using task, not startingState");
      startingState["TASK.md"] = {
        bytes: read(task.task),
        mode: fs.statSync(path.resolve(root, task.task)).mode & 0o777,
      };
      const protectedFiles = [...new Set(["TASK.md", ...task.protected])];
      for (const name of protectedFiles)
        if (
          !Object.keys(startingState).some((file) => file === name || file.startsWith(`${name}/`))
        )
          throw new Error(`Protected path is absent from starting state: ${name}`);
      const evaluationFiles = expand(task.evaluation.files);
      for (const [file, keys] of Object.entries(task.evaluation.controlFiles)) {
        if (Object.hasOwn(evaluationFiles, file))
          throw new Error(`Duplicate evaluator path: ${file}`);
        for (const key of keys)
          if (key === "authFile") throw new Error(`Credential control is forbidden: ${key}`);
      }
      const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      const outputs = Object.values(task.outputs);
      const evaluatorPaths = [
        ...Object.keys(evaluationFiles),
        ...Object.keys(task.evaluation.controlFiles),
      ];
      if (evaluatorPaths.includes("evalkit.yaml"))
        throw new Error("evalkit.yaml is supplied by evaluation.config");
      for (const [index, destination] of outputs.entries()) {
        if (outputs.slice(0, index).some((other) => overlaps(destination, other)))
          throw new Error(`Overlapping output destinations: ${destination}`);
        if (["evalkit.yaml", ...evaluatorPaths].some((file) => overlaps(destination, file)))
          throw new Error(`Output destination overlaps evaluator: ${destination}`);
      }
      return {
        ...task,
        startingState,
        protected: protectedFiles,
        evaluationFiles,
        config: read(task.evaluation.config),
      };
    }),
  };
}
