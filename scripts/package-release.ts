import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { KIT_VERSION } from "../src/version.js";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output"))
  throw new Error("Usage: pnpm package:release [--output directory]");
const output = path.resolve(args[1] ?? path.join(root, ".agent-eval/release"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== KIT_VERSION)
  throw new Error("package.json and src/version.ts must declare the same version");
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag !== undefined && tag !== `v${pkg.version}`)
  throw new Error(`Release tag must equal v${pkg.version}; found ${tag}`);
fs.mkdirSync(output, { recursive: true });
function run(command: string, argv: string[]) {
  const result = spawnSync(command, argv, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
run("pnpm", ["build"]);
const packed = JSON.parse(
  run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output]),
);
if (!Array.isArray(packed) || packed.length !== 1 || packed[0].version !== pkg.version)
  throw new Error("Unexpected packed package metadata");
const artifact = packed[0];
for (const file of [
  "dist/cli.js",
  "dist/browser/mcp.js",
  "dist/workspace/mcp.js",
  "dist/text/rubric.js",
  "dist/starters/visual.js",
  "examples/visual/calibrate.mjs",
  "examples/visual/README.md",
  "examples/visual/server.mjs",
  "examples/visual/evalkit.yaml",
  "examples/visual/index.html",
  "examples/visual/reference.svg",
  "examples/visual/specs/dashboard.yaml",
])
  if (!artifact.files.some((entry: { path: string }) => entry.path === file))
    throw new Error(`Release archive is missing ${file}`);
if (
  artifact.files.some(
    (entry: { path: string }) =>
      /^(src|node_modules)\//.test(entry.path) || /(^|\/)\.agent-eval\//.test(entry.path),
  )
)
  throw new Error("Release archive must not contain source files, node_modules, or run artifacts");
const archive = path.join(output, path.basename(artifact.filename));
const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
console.log(`Built ${archive}\nSHA-256 ${digest}`);
