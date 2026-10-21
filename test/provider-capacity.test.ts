import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withCancellation } from "../src/cancellation.js";
import { isCapacityFailure, withCapacityRetries } from "../src/providers/capacity.js";
import { runProvider } from "../src/providers/index.js";
import type { ProviderInvocation, ProviderResult } from "../src/types.js";

test("capacity classification excludes verdicts, timeouts, policy failures, billing and ordinary errors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-capacity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invocation: ProviderInvocation = {
    purpose: "judge",
    capacityRetries: 2,
    cwd: root,
    promptFile: path.join(root, "prompt.md"),
    outputFile: path.join(root, "final.json"),
    outputSchemaFile: path.join(root, "schema.json"),
    eventLogFile: path.join(root, "events.ndjson"),
    stderrFile: path.join(root, "stderr.log"),
    timeoutSeconds: 60,
    extraArgs: [],
    allowWorkspaceTools: false,
  };
  const result: ProviderResult = {
    provider: "codex",
    exitCode: 1,
    signal: null,
    timedOut: false,
    finalText: "",
    command: ["codex"],
  };
  for (const message of [
    "Model gpt-6.1-sol is at capacity",
    "insufficient_capacity",
    "overloaded_error",
    "No available model capacity",
  ]) {
    fs.writeFileSync(invocation.stderrFile, message);
    assert.equal(isCapacityFailure(result, invocation), true, message);
  }
  fs.writeFileSync(invocation.stderrFile, "");
  assert.equal(
    isCapacityFailure(
      { ...result, structured: { error: { code: "insufficient_capacity" } } },
      invocation,
    ),
    true,
  );
  assert.equal(
    isCapacityFailure(
      { ...result, structured: { error: "insufficient_capacity", preferred: "B" } },
      invocation,
    ),
    false,
  );
  assert.equal(
    isCapacityFailure(
      { ...result, finalText: "server_overloaded", finalTextSource: "error" },
      invocation,
    ),
    true,
  );
  fs.writeFileSync(
    invocation.eventLogFile,
    JSON.stringify({ type: "result", is_error: true, errors: ["overloaded_error"] }),
  );
  assert.equal(isCapacityFailure(result, invocation), true);
  fs.writeFileSync(invocation.eventLogFile, "");
  fs.writeFileSync(invocation.stderrFile, "Quota exceeded: model is at capacity");
  assert.equal(isCapacityFailure(result, invocation), false);
  fs.writeFileSync(invocation.stderrFile, "Model is at capacity");
  for (const extra of [
    { exitCode: 0 },
    { timedOut: true },
    { signal: "SIGTERM" as const },
    { policyViolations: ["command_execution"] },
    { responseEmitted: true },
    { finalText: '{"preferred": BROKEN' },
    { structured: null, finalText: "null" },
    { structured: { preferred: "B" } },
    { structured: { preferred: "B" }, finalTextSource: "error" as const },
    { structured: { items: [] } },
  ])
    assert.equal(isCapacityFailure({ ...result, ...extra }, invocation), false);
  for (const message of [
    "Authentication failed",
    "Usage limit reached",
    "Quota exceeded",
    "429 rate limit",
    "invalid JSON output",
  ]) {
    fs.writeFileSync(invocation.stderrFile, message);
    assert.equal(isCapacityFailure(result, invocation), false, message);
  }
  fs.writeFileSync(invocation.stderrFile, "");
  fs.writeFileSync(
    invocation.eventLogFile,
    JSON.stringify({ type: "item.completed", item: { text: "Model is at capacity" } }),
  );
  assert.equal(isCapacityFailure(result, invocation), false);
  fs.writeFileSync(
    invocation.eventLogFile,
    JSON.stringify({ type: "turn.failed", error: { message: "Model is at capacity" } }),
  );
  assert.equal(isCapacityFailure(result, invocation), true);
});

test("capacity retries are bounded, retain attempts, and cancellation interrupts backoff", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-capacity-bound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invocation: ProviderInvocation = {
    purpose: "judge",
    capacityRetries: 1,
    cwd: root,
    promptFile: path.join(root, "prompt.md"),
    outputFile: path.join(root, "final.json"),
    outputSchemaFile: path.join(root, "schema.json"),
    eventLogFile: path.join(root, "events.ndjson"),
    stderrFile: path.join(root, "stderr.log"),
    timeoutSeconds: 60,
    extraArgs: [],
    allowWorkspaceTools: false,
  };
  const result: ProviderResult = {
    provider: "codex",
    exitCode: 19,
    signal: null,
    timedOut: false,
    finalText: "",
    command: ["codex"],
  };
  let calls = 0;
  const run = async () => {
    calls++;
    fs.writeFileSync(invocation.stderrFile, "Model is at capacity");
    return result;
  };
  assert.equal(await withCapacityRetries(invocation, run), result);
  assert.equal(calls, 2);
  assert.equal(
    fs.existsSync(path.join(root, "capacity-retries/attempt-1/provider-run.json")),
    true,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancel capacity backoff")), 50);
  try {
    await assert.rejects(
      withCancellation(controller.signal, () => withCapacityRetries(invocation, run)),
      /aborted/i,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(calls, 3);
  // Scenario collection is never retried; neither are thrown adapter/contract errors.
  await withCapacityRetries({ ...invocation, purpose: "scenario" }, run);
  assert.equal(calls, 4);
  await assert.rejects(
    withCapacityRetries(invocation, async () => {
      calls++;
      throw new Error("malformed event");
    }),
    /malformed event/,
  );
  assert.equal(calls, 5);
});

test("Claude capacity retries distinguish absent results from decisions and ordinary failures", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-claude-capacity-"));
  const bin = path.join(root, "bin"),
    config = path.join(root, "config"),
    responses = path.join(root, "responses.json"),
    calls = path.join(root, "calls.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(config);
  const originalPath = process.env.PATH,
    originalConfig = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.CLAUDE_CONFIG_DIR = config;
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
const fs=require('node:fs');
process.stdin.resume();process.stdin.on('end',()=>{
 const calls=${JSON.stringify(calls)},count=JSON.parse(fs.readFileSync(calls,'utf8'));
 fs.writeFileSync(calls,JSON.stringify(count+1));
 const responses=JSON.parse(fs.readFileSync(${JSON.stringify(responses)},'utf8'));
 const response=responses[Math.min(count,responses.length-1)];
 for(const event of Array.isArray(response.event)?response.event:[response.event])
  console.log(typeof event==='string'?event:JSON.stringify(event));
 process.exitCode=response.exitCode;
});
`,
    { mode: 0o755 },
  );
  const overload = { type: "result", is_error: true, errors: ["overloaded_error"] };
  const decision = { preferred: "B", confidence: 0.95 };
  const success = { type: "result", structured_output: decision };
  for (const scenario of [
    { name: "overload-then-success", event: overload, retry: true, success: true },
    {
      name: "overload-message-then-success",
      event: { ...overload, result: "overloaded_error" },
      retry: true,
      success: true,
    },
    { name: "overload-exhausted", event: overload, retry: true, success: false },
    {
      name: "quota",
      event: { ...overload, errors: ["Quota exceeded: overloaded_error"] },
      retry: false,
      success: false,
    },
    {
      name: "decision",
      event: { ...overload, structured_output: decision },
      retry: false,
      success: false,
    },
    {
      name: "streamed-structured-before-error",
      event: [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "StructuredOutput", input: decision }] },
        },
        overload,
      ],
      retry: false,
      success: false,
    },
    {
      name: "streamed-text-before-error",
      event: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: JSON.stringify(decision) }] },
        },
        overload,
      ],
      retry: false,
      success: false,
    },
    {
      name: "streamed-malformed-before-error",
      event: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: '{"preferred": BROKEN' }] },
        },
        overload,
      ],
      retry: false,
      success: false,
    },
    { name: "malformed-event", event: "not-json", retry: false, success: false },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = path.join(root, scenario.name);
      fs.mkdirSync(directory);
      fs.writeFileSync(calls, "0");
      fs.writeFileSync(
        responses,
        JSON.stringify([
          { event: scenario.event, exitCode: 1 },
          ...(scenario.success ? [{ event: success, exitCode: 0 }] : []),
        ]),
      );
      const invocation: ProviderInvocation = {
        purpose: "judge",
        capacityRetries: 1,
        cwd: directory,
        promptFile: path.join(directory, "prompt.md"),
        outputFile: path.join(directory, "provider-final.json"),
        outputSchemaFile: path.join(directory, "schema.json"),
        eventLogFile: path.join(directory, "events.ndjson"),
        stderrFile: path.join(directory, "stderr.log"),
        timeoutSeconds: 10,
        extraArgs: [],
        allowWorkspaceTools: false,
      };
      fs.writeFileSync(invocation.promptFile, "Return a structured decision.");
      fs.writeFileSync(invocation.outputSchemaFile, "{}");
      if (scenario.name === "malformed-event") {
        await assert.rejects(runProvider("claude", invocation), /malformed stream-json/);
      } else {
        const result = await runProvider("claude", invocation);
        assert.equal(result.exitCode, scenario.success ? 0 : 1);
        assert.deepEqual(
          result.structured,
          scenario.success || scenario.name === "decision" ? decision : undefined,
        );
        if (scenario.name.startsWith("streamed")) assert.equal(result.responseEmitted, true);
      }
      assert.equal(JSON.parse(fs.readFileSync(calls, "utf8")), scenario.retry ? 2 : 1);
      const archive = path.join(directory, "capacity-retries/attempt-1");
      assert.equal(fs.existsSync(archive), scenario.retry);
      if (scenario.retry) {
        assert.match(
          fs.readFileSync(path.join(archive, "events.ndjson"), "utf8"),
          /overloaded_error/,
        );
        assert.equal(
          fs.readFileSync(path.join(archive, "provider-final.json"), "utf8"),
          typeof scenario.event === "object" && "result" in scenario.event
            ? scenario.event.result
            : "",
        );
      }
    });
  }
});

test("Codex capacity retries never replace malformed answers or parsed non-decisions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-codex-capacity-output-"));
  const bin = path.join(root, "bin"),
    calls = path.join(root, "calls.json"),
    response = path.join(root, "response.json");
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),calls=${JSON.stringify(calls)};
const count=JSON.parse(fs.readFileSync(calls,'utf8'));
fs.writeFileSync(calls,JSON.stringify(count+1));
const output=args[args.indexOf('--output-last-message')+1];
if(count===0){
 const response=JSON.parse(fs.readFileSync(${JSON.stringify(response)},'utf8'));
 fs.writeFileSync(output,response.finalText);
 if(response.streamed!==undefined)console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:response.streamed}}));
 console.log(JSON.stringify({type:'turn.failed',error:{message:'Model is at capacity'}}));
 process.exitCode=1;
}else{
 const text=JSON.stringify({preferred:'equivalent'});
 fs.writeFileSync(output,text);
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
}
`,
    { mode: 0o755 },
  );
  const responses: Array<{ finalText: string; streamed?: string }> = [
    { finalText: '{"preferred": BROKEN' },
    { finalText: "not JSON" },
    { finalText: "null" },
    { finalText: "" },
    { finalText: "", streamed: '{"preferred":"B"}' },
    { finalText: "", streamed: '{"preferred": BROKEN' },
  ];
  for (const [index, sample] of responses.entries()) {
    await t.test(sample.streamed ?? (sample.finalText || "absent-answer"), async () => {
      const directory = path.join(root, String(index));
      fs.mkdirSync(directory);
      fs.writeFileSync(calls, "0");
      fs.writeFileSync(response, JSON.stringify(sample));
      const invocation: ProviderInvocation = {
        purpose: "judge",
        capacityRetries: 1,
        cwd: directory,
        promptFile: path.join(directory, "prompt.md"),
        outputFile: path.join(directory, "provider-final.json"),
        outputSchemaFile: path.join(directory, "schema.json"),
        eventLogFile: path.join(directory, "events.ndjson"),
        stderrFile: path.join(directory, "stderr.log"),
        timeoutSeconds: 10,
        extraArgs: [],
        allowWorkspaceTools: false,
      };
      fs.writeFileSync(invocation.promptFile, "Return JSON.");
      fs.writeFileSync(invocation.outputSchemaFile, "{}");
      const result = await runProvider("codex", invocation);
      const retry = !sample.finalText && sample.streamed === undefined;
      assert.equal(result.exitCode, retry ? 0 : 1);
      assert.equal(JSON.parse(fs.readFileSync(calls, "utf8")), retry ? 2 : 1);
      assert.equal(fs.existsSync(path.join(directory, "capacity-retries")), retry);
      assert.equal(result.finalText, retry ? '{"preferred":"equivalent"}' : sample.finalText);
      if (sample.streamed !== undefined) assert.equal(result.responseEmitted, true);
      assert.equal(fs.readFileSync(invocation.outputFile, "utf8"), result.finalText);
    });
  }
});
