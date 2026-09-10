import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  shellInvocation,
  spawnCaptured,
  subscriptionEnvironment,
} from "../src/providers/process.js";
import { withCancellation } from "../src/cancellation.js";

for (const reason of ["timeout", "cancellation"] as const) {
  test(`${reason} waits for descendants after the captured leader exits`, {
    skip: process.platform === "win32",
    timeout: 15_000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-descendant-"));
    const controller = new AbortController();
    let descendantPid = 0;
    // The descendant closes inherited pipes and acknowledges installing its
    // signal handler before its parent announces readiness to the harness.
    const descendant = `process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000);`;
    const parent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',pid=>console.log(pid)); setInterval(()=>{},1000);`;
    try {
      const invocation = withCancellation(controller.signal, () =>
        spawnCaptured({
          command: process.execPath,
          args: ["-e", parent],
          cwd: root,
          timeoutSeconds: reason === "timeout" ? 1 : 30,
          stdoutFile: path.join(root, "stdout.log"),
          stderrFile: path.join(root, "stderr.log"),
          onLine: (stream, line) => {
            if (stream !== "stdout") return;
            descendantPid = Number(line);
            if (reason === "cancellation") controller.abort(new Error("test interruption"));
          },
        }),
      );
      if (reason === "timeout") assert.equal((await invocation).timedOut, true);
      else await assert.rejects(invocation, /test interruption/);
      assert.ok(descendantPid > 0, "descendant started before termination");
      assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("shell execution rejects native Windows instead of guessing at process cleanup", () => {
  assert.throws(
    () => shellInvocation("pnpm test", "win32"),
    /Native Windows evaluation is not supported/,
  );
  assert.deepEqual(shellInvocation("pnpm test", "linux"), {
    command: "bash",
    args: ["--noprofile", "--norc", "-c", "pnpm test"],
  });
});

for (const invalidLog of [false, true]) {
  test(`synchronous spawn errors close both logs${invalidLog ? " even when a log cannot open" : ""}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-spawn-error-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const create = fs.createWriteStream;
    const streams: fs.WriteStream[] = [];
    t.mock.method(fs, "createWriteStream", (...args: Parameters<typeof create>) => {
      const stream = create(...args);
      streams.push(stream);
      return stream;
    });
    await assert.rejects(
      spawnCaptured({
        command: process.execPath,
        args: ["\0"],
        cwd: root,
        timeoutSeconds: 10,
        stdoutFile: invalidLog ? root : path.join(root, "stdout.log"),
        stderrFile: path.join(root, "stderr.log"),
      }),
      { code: "ERR_INVALID_ARG_VALUE" },
    );
    assert.equal(streams.length, 2);
    for (const stream of streams) assert.equal(stream.closed, true);
  });
}

test("subscription provider environments expose only required runtime settings", () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_URL",
    "AEK_TEST_PROJECT_SECRET",
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "must-not-be-inherited";
  try {
    const environment = subscriptionEnvironment();
    for (const name of names) assert.equal(environment[name], undefined, name);
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal(environment.NO_COLOR, "1");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("subscription provider environments fail fast on credential-bearing proxies", () => {
  const original = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "https://proxy-user:proxy-password@proxy.example.test:8443";
  try {
    assert.throws(
      () => subscriptionEnvironment(),
      /credential-bearing provider proxy setting HTTPS_PROXY/,
    );
  } finally {
    if (original === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = original;
  }
});

test("captured process output is fully flushed before returning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-"));
  const expectedBytes = 2 * 1024 * 1024;
  const stdoutFile = path.join(root, "stdout.log");
  const result = await spawnCaptured({
    command: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(${expectedBytes}))`],
    cwd: root,
    timeoutSeconds: 10,
    stdoutFile,
    stderrFile: path.join(root, "stderr.log"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.statSync(stdoutFile).size, expectedBytes);
  assert.equal(result.stdout.length, expectedBytes);
});

test("captured process output preserves UTF-8 split across pipe chunks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-utf8-"));
  const stdoutFile = path.join(root, "stdout.log");
  const stderrFile = path.join(root, "stderr.log");
  const expected = `${JSON.stringify({ message: "café 😀" })}\n`;
  const lines: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  try {
    const result = await spawnCaptured({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require("node:fs");for(const byte of Buffer.from(${JSON.stringify(expected)})){fs.writeSync(1,Buffer.from([byte]));fs.writeSync(2,Buffer.from([byte]));}`,
      ],
      cwd: root,
      timeoutSeconds: 10,
      stdoutFile,
      stderrFile,
      onLine: (stream, line) => lines[stream].push(line),
    });
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, expected);
    assert.equal(fs.readFileSync(stdoutFile, "utf8"), expected);
    assert.equal(fs.readFileSync(stderrFile, "utf8"), expected);
    assert.deepEqual(lines.stdout, [expected.trim()]);
    assert.deepEqual(lines.stderr, [expected.trim()]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("newline-free output above the capture limit is logged fully without a line consumer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-large-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = 32 * 1024 * 1024;
  const result = await spawnCaptured({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs'); const chunk=Buffer.alloc(65536,120); for(let i=0;i<${bytes}/chunk.length;i++){fs.writeSync(1,chunk);fs.writeSync(2,chunk);}`,
    ],
    cwd: root,
    timeoutSeconds: 30,
    stdoutFile: path.join(root, "stdout.log"),
    stderrFile: path.join(root, "stderr.log"),
  });
  assert.equal(result.exitCode, 0);
  for (const stream of ["stdout", "stderr"] as const) {
    assert.equal(result[stream], "x".repeat(12 * 1024 * 1024));
    assert.equal(fs.statSync(path.join(root, `${stream}.log`)).size, bytes);
  }
});

for (const stream of ["stdout", "stderr"] as const) {
  for (const newline of [false, true]) {
    test(`oversized ${stream} event rejects and terminates the child (${newline ? "terminated" : "unterminated"} line)`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-event-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      let pid = 0;
      await assert.rejects(
        spawnCaptured({
          command: process.execPath,
          args: [
            "-e",
            `console.log(process.pid); process.${stream}.write('x'.repeat(13*1024*1024) + ${JSON.stringify(newline ? "\n" : "")}); setInterval(()=>{},1000);`,
          ],
          cwd: root,
          timeoutSeconds: 30,
          stdoutFile: path.join(root, "stdout.log"),
          stderrFile: path.join(root, "stderr.log"),
          onLine: (source, line) => {
            assert.equal(source, "stdout");
            assert.equal(pid, 0, "oversized event must not reach the callback");
            pid = Number(line);
          },
        }),
        new RegExp(`Subprocess ${stream} event line exceeds 12582912 UTF-8 bytes`),
      );
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.ok(fs.statSync(path.join(root, `${stream}.log`)).size > 0);
    });
  }
}

test("event line bounds count UTF-8 bytes and accept an exact-limit line", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-line-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received: number[] = [];
  await assert.rejects(
    spawnCaptured({
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs'); const line='é'.repeat(6*1024*1024);fs.writeSync(1,line+'\\n');fs.writeSync(1,line+'é\\n');",
      ],
      cwd: root,
      timeoutSeconds: 30,
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
      onLine: (_stream, line) => received.push(Buffer.byteLength(line)),
    }),
    /event line exceeds/,
  );
  assert.deepEqual(received, [12 * 1024 * 1024]);
});

test("line framing preserves CRLF, empty lines, and final unterminated output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-lines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received: string[] = [];
  await spawnCaptured({
    command: process.execPath,
    args: ["-e", "process.stdout.write('one\\r\\n\\nlast')"],
    cwd: root,
    timeoutSeconds: 10,
    stdoutFile: path.join(root, "stdout.log"),
    stderrFile: path.join(root, "stderr.log"),
    onLine: (_stream, line) => received.push(line),
  });
  assert.deepEqual(received, ["one", "", "last"]);
});

for (const newline of [false, true]) {
  test(`line callback errors reject (${newline ? "terminated" : "unterminated"} line)`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-callback-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await assert.rejects(
      spawnCaptured({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(newline ? "line\n" : "line")})`],
        cwd: root,
        timeoutSeconds: 10,
        stdoutFile: path.join(root, "stdout.log"),
        stderrFile: path.join(root, "stderr.log"),
        onLine: () => {
          throw new Error("consumer rejected event");
        },
      }),
      /consumer rejected event/,
    );
  });
}

test("slow log writers bound queued output and flush both streams", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-backpressure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const create = fs.createWriteStream;
  const peaks: number[] = [];
  t.mock.method(fs, "createWriteStream", (...args: Parameters<typeof create>) => {
    const output = create(args[0], { ...(args[1] as object), highWaterMark: 1024 });
    const index = peaks.push(0) - 1;
    const write = output._write.bind(output);
    t.mock.method(output, "_write", (...values: Parameters<typeof write>) => {
      peaks[index] = Math.max(peaks[index]!, output.writableLength);
      setTimeout(() => write(...values), 5);
    });
    const writev = output._writev!.bind(output);
    output._writev = (...values: Parameters<typeof writev>) => {
      peaks[index] = Math.max(peaks[index]!, output.writableLength);
      setTimeout(() => writev(...values), 5);
    };
    return output;
  });
  const bytes = 2 * 1024 * 1024;
  const result = await spawnCaptured({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write('a'.repeat(${bytes}));process.stderr.write('b'.repeat(${bytes}));`,
    ],
    cwd: root,
    timeoutSeconds: 10,
    stdoutFile: path.join(root, "stdout.log"),
    stderrFile: path.join(root, "stderr.log"),
  });
  assert.equal(result.exitCode, 0);
  for (const [stream, character] of [
    ["stdout", "a"],
    ["stderr", "b"],
  ] as const) {
    assert.equal(result[stream], character.repeat(bytes));
    assert.equal(fs.readFileSync(path.join(root, `${stream}.log`), "utf8"), result[stream]);
  }
  for (const peak of peaks) assert.ok(peak > 0 && peak <= 256 * 1024, `queued ${peak} bytes`);
});

test("log write failures reject promptly and terminate the producer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-log-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const create = fs.createWriteStream;
  let pid = 0;
  t.mock.method(fs, "createWriteStream", (...args: Parameters<typeof create>) => {
    const output = create(...args);
    if (String(args[0]).endsWith("stderr.log")) {
      t.mock.method(
        output,
        "_write",
        (...[_chunk, _encoding, callback]: Parameters<typeof output._write>) => {
          callback(new Error("simulated disk full"));
        },
      );
    }
    return output;
  });
  await assert.rejects(
    spawnCaptured({
      command: process.execPath,
      args: [
        "-e",
        "console.log(process.pid);setTimeout(()=>process.stderr.write('error'),100);setInterval(()=>{},1000)",
      ],
      cwd: root,
      timeoutSeconds: 30,
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
      onLine: (_stream, line) => {
        pid = Number(line);
      },
    }),
    /Cannot write subprocess stderr log .*simulated disk full/,
  );
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("output errors retain process cleanup failures in the diagnostic", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-cleanup-error-"));
  const kill = process.kill.bind(process);
  let pid = 0;
  t.after(() => {
    if (pid) {
      try {
        kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(process, "kill", (target: number, signal?: string | number) => {
    if (target < 0 && signal === "SIGTERM") throw new Error("simulated process cleanup denial");
    return kill(target, signal);
  });
  await assert.rejects(
    spawnCaptured({
      command: process.execPath,
      args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
      cwd: root,
      timeoutSeconds: 10,
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
      onLine: (_stream, line) => {
        pid = Number(line);
        throw new Error("consumer rejected event");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /consumer rejected event/);
      assert.match(error.message, /simulated process cleanup denial/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});

for (const reason of ["timeout", "cancellation"] as const) {
  test(`${reason} stops a producer while its log writer is backpressured`, {
    timeout: 10_000,
  }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-paused-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const create = fs.createWriteStream;
    let written = false;
    t.mock.method(fs, "createWriteStream", (...args: Parameters<typeof create>) => {
      const output = create(args[0], { ...(args[1] as object), highWaterMark: 1 });
      const write = output._write.bind(output);
      t.mock.method(output, "_write", (...values: Parameters<typeof write>) => {
        if (reason === "cancellation") controller.abort(new Error("cancel paused writer"));
        setTimeout(() => {
          written = true;
          write(...values);
        }, 500);
      });
      return output;
    });
    const invocation = withCancellation(controller.signal, () =>
      spawnCaptured({
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');fs.writeFileSync('pid',String(process.pid));const chunk=Buffer.alloc(65536,120);while(true)fs.writeSync(1,chunk);",
        ],
        cwd: root,
        timeoutSeconds: reason === "timeout" ? 0.2 : 30,
        stdoutFile: path.join(root, "stdout.log"),
        stderrFile: path.join(root, "stderr.log"),
      }),
    );
    if (reason === "timeout") assert.equal((await invocation).timedOut, true);
    else await assert.rejects(invocation, /cancel paused writer/);
    assert.equal(written, true, "pending writes finish before the invocation settles");
    assert.ok(fs.statSync(path.join(root, "stdout.log")).size > 0);
    const pid = Number(fs.readFileSync(path.join(root, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
}
