import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnCaptured } from "../src/providers/process.js";

const kitRoot = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-package-smoke-"));
let ordinal = 0;
async function run(command: string, args: string[], cwd: string): Promise<string> {
  const id = ++ordinal;
  const result = await spawnCaptured({
    command, args, cwd, timeoutSeconds: 180,
    stdoutFile: path.join(scratch, `${id}.stdout.log`), stderrFile: path.join(scratch, `${id}.stderr.log`),
  });
  assert.equal(result.timedOut, false, `Timed out: ${command}`);
  assert.equal(result.exitCode, 0, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  await run(process.execPath, [path.join(kitRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], kitRoot);
  const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], kitRoot));
  const archive = path.join(scratch, packed[0].filename);
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "aek-package-consumer", private: true }));
  await run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", archive], consumer);
  const installed = path.join(consumer, "node_modules/agent-eval-kit");
  assert.equal(fs.existsSync(path.join(installed, "src")), false, "package should run without source files");
  assert.equal(fs.existsSync(path.join(consumer, "node_modules/tsx")), false, "consumer should not need tsx");
  const cli = path.join(consumer, "node_modules/.bin/aek");
  assert.match(await run(cli, ["--help"], consumer), /Agent Eval Kit/);
  await run(cli, ["init"], consumer);
  const configFile = path.join(consumer, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.target = { kind: "repository" };
  config.agent = { provider: "mock" };
  config.judge = { provider: "mock" };
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(path.join(consumer, "evals/specs/core.yaml"), YAML.stringify({
    id: "core", title: "Installed package", description: "Production dependency smoke", weight: 100,
    scenarios: [{ id: "S1", name: "Inspect", instructions: "Inspect the project" }],
    rubric: [{ id: "R1", criterion: "Installed CLI runs", weight: 1, gate: true, grader: { type: "command", output: "exit-code", command: "node -e \"process.exit(0)\"" }, passCriteria: "Exit zero" }],
  }));
  await run(cli, ["validate"], consumer);
  await run(cli, ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"], consumer);
  const runsRoot = path.join(consumer, ".agent-eval/runs");
  const runDir = path.join(runsRoot, fs.readdirSync(runsRoot)[0]);
  await run(cli, ["verify", "--run", runDir], consumer);
  assert.ok(fs.existsSync(path.join(runDir, "report.html")));

  // Launch the installed MCP entry point with production dependencies only.
  // Mock evaluations alone would never start an MCP subprocess.
  const evidence = path.join(scratch, "workspace-evidence");
  const contextFile = path.join(scratch, "workspace-context.json");
  fs.writeFileSync(contextFile, JSON.stringify({ projectRoot: consumer, evidenceDir: evidence }));
  const client = new Client({ name: "aek-package-smoke", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(installed, "dist/workspace/mcp.js"), contextFile], cwd: consumer });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "read_file", arguments: { path: "package.json" } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /aek-package-consumer/);
    await client.callTool({ name: "done", arguments: { outcome: "completed", summary: "Installed workspace MCP reads project files." } });
  } finally {
    await client.close();
    await transport.close();
  }
  console.log("Package smoke passed: tarball install, executable bin, init, validate, run, verify, and installed MCP without dev dependencies.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
