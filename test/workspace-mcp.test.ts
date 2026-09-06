import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeJson } from "../src/io.js";
import { workspaceMcpLaunch } from "../src/mcp-config.js";
import type { WorkspaceMcpContext } from "../src/workspace/context.js";

test("workspace MCP provides bounded read-only evidence and blocks path escapes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-workspace-mcp-"));
  const project = path.join(directory, "project");
  const evidence = path.join(directory, "evidence");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "evals"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(path.join(project, "custom-runs"), { recursive: true });
  fs.mkdirSync(path.join(project, "custom-auth"), { recursive: true });
  fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(project, "src", "hello.ts"), "export const greeting = 'hello';\n");
  fs.writeFileSync(path.join(project, "src", "minified.js"), "x".repeat(100_000));
  fs.writeFileSync(
    path.join(project, "src", "many-lines.txt"),
    Array.from({ length: 1_205 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  fs.writeFileSync(path.join(project, "evalkit.yaml"), "secret evaluator configuration\n");
  fs.writeFileSync(path.join(project, ".git", "config"), "credential-bearing remote\n");
  fs.writeFileSync(path.join(project, "evals", "rubric.yaml"), "secret pass criteria\n");
  fs.writeFileSync(path.join(project, "custom-runs", "prior-judge-prompt.md"), "secret prior rubric\n");
  fs.writeFileSync(path.join(project, "custom-auth", "persona.json"), "secret browser session\n");
  fs.writeFileSync(path.join(directory, "outside.txt"), "must remain inaccessible\n");
  fs.symlinkSync(path.join(directory, "outside.txt"), path.join(project, "escape.txt"));
  const contextFile = path.join(directory, "context.json");
  const context: WorkspaceMcpContext = {
    projectRoot: project,
    evidenceDir: evidence,
    maxToolCalls: 20,
    evaluatorOnlyPaths: [
      path.join(project, "evalkit.yaml"),
      path.join(project, "evals"),
      path.join(project, "custom-runs"),
      path.join(project, "custom-auth"),
      path.join(project, ".env"),
      path.join(project, "future-auth"),
    ],
  };
  writeJson(contextFile, context);
  const launch = workspaceMcpLaunch(contextFile);
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: evidence, stderr: "pipe" });
    const client = new Client({ name: "aek-workspace-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      // Optional evaluator-only locations can be absent at startup. If they
      // appear while the server is running, they must still remain hidden.
      fs.writeFileSync(path.join(project, ".env"), "LATE_SECRET=hidden\n");
      fs.mkdirSync(path.join(project, "future-auth"));
      fs.writeFileSync(path.join(project, "future-auth", "persona.json"), "late browser session\n");
      const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["done", "list_files", "observe", "publish_output", "read_file", "search"],
    );
    const listed = await client.callTool({ name: "list_files", arguments: {} });
    assert.match(JSON.stringify(listed.content), /src\/hello\.ts/);
    assert.doesNotMatch(JSON.stringify(listed.content), /escape\.txt/);
    assert.doesNotMatch(JSON.stringify(listed.content), /evalkit|rubric/);
    assert.doesNotMatch(JSON.stringify(listed.content), /custom-runs|custom-auth|prior-judge|persona/);
    assert.doesNotMatch(JSON.stringify(listed.content), /\.env|future-auth|LATE_SECRET|late browser session/);
    assert.doesNotMatch(JSON.stringify(listed.content), /\.git|credential-bearing/);
    const read = await client.callTool({ name: "read_file", arguments: { path: "src/hello.ts" } });
    assert.match(JSON.stringify(read.content), /1: export const greeting/);
    const boundedRead = await client.callTool({ name: "read_file", arguments: { path: "src/minified.js" } });
    assert.ok(JSON.stringify(boundedRead.content).length < 33_000);
    assert.match(JSON.stringify(boundedRead.content), /read output truncated at 32000 characters/);
    const lineBoundedRead = await client.callTool({
      name: "read_file",
      arguments: { path: "src/many-lines.txt", startLine: 1, endLine: 1_200 },
    });
    const lineBoundedText = JSON.stringify(lineBoundedRead.content);
    assert.match(lineBoundedText, /1000: line 1000/);
    assert.doesNotMatch(lineBoundedText, /1001: line 1001/);
    assert.match(lineBoundedText, /read output truncated at 1000 lines; continue with startLine 1001/);
    const search = await client.callTool({ name: "search", arguments: { query: "GREETING" } });
    assert.match(JSON.stringify(search.content), /src\/hello\.ts:1/);
    const bulk = path.join(project, "bulk");
    fs.mkdirSync(bulk);
    for (let index = 0; index < 4_001; index++) {
      fs.writeFileSync(path.join(bulk, `file-${String(index).padStart(4, "0")}.txt`), "ordinary content\n");
    }
    const truncatedSearch = await client.callTool({ name: "search", arguments: { query: "not-present-anywhere" } });
    assert.match(JSON.stringify(truncatedSearch.content), /no matches.*search file set truncated after 4000 eligible files/s);
    const escaped = await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } });
    assert.equal(escaped.isError, true);
    assert.match(JSON.stringify(escaped.content), /escapes project root/);
    const evaluatorConfig = await client.callTool({ name: "read_file", arguments: { path: "evalkit.yaml" } });
    assert.equal(evaluatorConfig.isError, true);
    assert.match(JSON.stringify(evaluatorConfig.content), /Evaluator-only path/);
    const lateEnvironment = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    assert.equal(lateEnvironment.isError, true);
    assert.match(JSON.stringify(lateEnvironment.content), /Evaluator-only path/);
    const vcsList = await client.callTool({ name: "list_files", arguments: { path: ".git" } });
    assert.equal(vcsList.isError, true);
    assert.match(JSON.stringify(vcsList.content), /Excluded project path/);
    const vcsConfig = await client.callTool({ name: "read_file", arguments: { path: ".git/config" } });
    assert.equal(vcsConfig.isError, true);
    assert.match(JSON.stringify(vcsConfig.content), /Excluded project path/);
    const hiddenSearch = await client.callTool({ name: "search", arguments: { query: "secret" } });
    assert.doesNotMatch(JSON.stringify(hiddenSearch.content), /evaluator|criteria/);
    await client.callTool({ name: "observe", arguments: { note: "src/hello.ts:1 exports greeting." } });
    await client.callTool({ name: "done", arguments: { outcome: "completed", summary: "Repository inspected." } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, "workspace-result.json"), "utf8")).outcome, "completed");
    assert.ok(fs.existsSync(path.join(evidence, "workspace-transcript.ndjson")));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
