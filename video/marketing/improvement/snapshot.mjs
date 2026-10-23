import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sources = {
  dashboard: { "DASHBOARD/page": "" },
  dispatch: {
    "WORKFLOW/html": "index.html",
    "WORKFLOW/css": "style.css",
    "WORKFLOW/app": "app.js",
    "WORKFLOW/data": "data.js",
    "WORKFLOW/font": "InterVariable.woff2",
  },
};

// A valid report and a valid snapshot are not enough: they must describe the same bytes.
export function assertEvaluatedSnapshot(kind, snapshot, expectedHash, report) {
  if (!Object.hasOwn(sources, kind)) throw Error(`Unsupported snapshot kind: ${kind}`);
  if (hashTarget(snapshot) !== expectedHash) throw Error(`Changed snapshot: ${snapshot}`);
  const evaluated = report.receipt?.inputs?.collectorSources;
  if (
    !evaluated ||
    Object.keys(evaluated).sort().join() !== Object.keys(sources[kind]).sort().join()
  )
    throw Error(`Report does not contain the complete ${kind} collector-source contract.`);
  for (const [label, name] of Object.entries(sources[kind])) {
    const bytes = fs.readFileSync(name ? path.join(snapshot, name) : snapshot);
    if (evaluated[label].sha256 !== sha256(bytes) || evaluated[label].bytes !== bytes.length)
      throw Error(
        `Evaluated source ${label} differs from snapshot ${snapshot}. ` +
          "The project changed before AEK captured its inputs; rerun with a new label before using this result.",
      );
  }
}

export function assertSessionSnapshots(root, session, kind) {
  const journal = fs
    .readFileSync(path.join(root, session, "journal.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  for (const entry of journal) {
    if (entry.executionError || ![0, 2].includes(entry.exitCode))
      throw Error(`Session contains an execution failure: ${entry.label}`);
    const report = JSON.parse(fs.readFileSync(path.join(root, entry.run, "report.json"), "utf8"));
    assertEvaluatedSnapshot(kind, path.join(root, entry.snapshot), entry.sha256, report);
  }
}

// A file target hashes its bytes. A directory target hashes its sorted file list,
// so multi-file products such as the dispatch prototype have one stable identity.
export function hashTarget(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return sha256(fs.readFileSync(target));
  if (!stat.isDirectory()) throw Error(`Unsupported target: ${target}`);
  const lines = fs
    .readdirSync(target)
    .map((name) => {
      const file = path.join(target, name);
      if (!fs.statSync(file).isFile())
        throw Error(`Directory targets must contain only files: ${name}`);
      return `${name}\0${sha256(fs.readFileSync(file))}\n`;
    })
    .sort();
  return sha256(lines.join(""));
}

// Copies resolve symlinks, so snapshots retain the exact bytes that were evaluated.
export function copyTarget(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  fs.mkdirSync(destination);
  for (const name of fs.readdirSync(source)) {
    if (!fs.statSync(path.join(source, name)).isFile())
      throw Error(`Directory targets must contain only files: ${name}`);
    fs.copyFileSync(
      path.join(source, name),
      path.join(destination, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
}
