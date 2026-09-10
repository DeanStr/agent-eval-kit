import { requireDefined } from "../invariants.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { terminateProcessTree } from "../process-tree.js";
import { cancellationSignal } from "../cancellation.js";
import { assertEvaluationPlatform } from "../platform.js";

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Keep provider-native instruction discovery outside the evaluated project.
 * Prompts, schemas, logs, and MCP context remain at their explicit absolute
 * artifact paths; only the provider process working directory is disposable.
 */
export async function withIsolatedProviderDirectory<T>(
  provider: "codex" | "claude",
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aek-${provider}-`));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function shellInvocation(
  script: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  assertEvaluationPlatform(platform);
  return { command: "bash", args: ["--noprofile", "--norc", "-c", script] };
}

// Captured tails are capped in UTF-16 code units, independently per stream.
const MAX_CAPTURE = 12 * 1024 * 1024;
// Event lines are capped in UTF-8 bytes, including a trailing CR but not LF.
const MAX_LINE_BYTES = 12 * 1024 * 1024;

export async function spawnCaptured(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  stdoutFile: string;
  stderrFile: string;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}): Promise<SpawnResult> {
  assertEvaluationPlatform();
  const signal = cancellationSignal();
  signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(options.stdoutFile), { recursive: true });
  fs.mkdirSync(path.dirname(options.stderrFile), { recursive: true });
  const stdoutStream = fs.createWriteStream(options.stdoutFile, { flags: "w" });
  const stderrStream = fs.createWriteStream(options.stderrFile, { flags: "w" });
  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      // spawn can reject arguments synchronously, before normal output handlers
      // exist. Close even still-opening logs and retain the original spawn error.
      void Promise.all(
        [stdoutStream, stderrStream].map(
          (stream) =>
            new Promise<void>((closed) => {
              stream.on("error", () => {});
              stream.once("close", closed);
              stream.destroy();
            }),
        ),
      ).then(() => reject(error));
      return;
    }
    let stdout = "";
    let stderr = "";
    const pendingLines = {
      stdout: { parts: [] as string[], bytes: 0 },
      stderr: { parts: [] as string[], bytes: 0 },
    };
    let outputError: Error | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersFlushed = false;
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;

    const capture = (current: string, chunk: string) => {
      const next = current + chunk;
      if (next.length <= MAX_CAPTURE) return next;
      const clipped = next.slice(-MAX_CAPTURE);
      // Do not create an unmatched low surrogate when the character cap lands
      // between the two UTF-16 code units of a supplementary character.
      return /[\uDC00-\uDFFF]/.test(requireDefined(clipped[0], "clipped[0]"))
        ? clipped.slice(1)
        : clipped;
    };
    const lines = (stream: "stdout" | "stderr", chunk: string) => {
      if (!options.onLine || outputError) return;
      const pending = pendingLines[stream];
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const part = chunk.slice(start, newline === -1 ? undefined : newline);
        pending.bytes += Buffer.byteLength(part, "utf8");
        if (pending.bytes > MAX_LINE_BYTES) {
          const log = stream === "stdout" ? options.stdoutFile : options.stderrFile;
          throw new Error(
            `Subprocess ${stream} event line exceeds ${MAX_LINE_BYTES} UTF-8 bytes; reduce the provider's event size. See ${log} for output retained before termination.`,
          );
        }
        pending.parts.push(part);
        if (newline === -1) return;
        const line = pending.parts.join("").replace(/\r$/, "");
        pending.parts = [];
        pending.bytes = 0;
        options.onLine(stream, line);
        start = newline + 1;
      }
    };

    const failOutput = (error: unknown) => {
      outputError ??=
        error instanceof Error
          ? error
          : new Error("Subprocess output handling failed", { cause: error });
      child.stdout.pause();
      child.stderr.pause();
      stop();
    };
    for (const stream of ["stdout", "stderr"] as const) {
      const input = child[stream];
      const output = stream === "stdout" ? stdoutStream : stderrStream;
      const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
      output.on("error", (error) => {
        const log = stream === "stdout" ? options.stdoutFile : options.stderrFile;
        failOutput(
          new Error(`Cannot write subprocess ${stream} log ${log}: ${error.message}`, {
            cause: error,
          }),
        );
      });
      output.on("drain", () => {
        if (!outputError && !settled) input.resume();
      });
      input.on("error", failOutput);
      input.on("data", (data: Buffer) => {
        if (outputError) return;
        try {
          if (!output.write(data)) input.pause();
          const chunk = decoder.write(data);
          if (stream === "stdout") stdout = capture(stdout, chunk);
          else stderr = capture(stderr, chunk);
          lines(stream, chunk);
        } catch (error) {
          failOutput(error);
        }
      });
    }
    const finishStream = (stream: fs.WriteStream) =>
      new Promise<void>((streamResolve, streamReject) => {
        if (stream.closed) {
          streamResolve();
          return;
        }
        stream.once("close", () => {
          if (stream.errored) streamReject(stream.errored);
          else streamResolve();
        });
        stream.end();
      });

    const finish = async (result: SpawnResult | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cleanupError: Error | undefined;
      // A closed leader does not imply its descendants exited. Keep the
      // escalation alive and await it before returning or removing isolation.
      try {
        await termination;
      } catch (terminationError) {
        cleanupError = terminationError as Error;
      }
      signal?.removeEventListener("abort", onAbort);
      try {
        if (!decodersFlushed && !outputError) {
          decodersFlushed = true;
          const stdoutTail = stdoutDecoder.end();
          const stderrTail = stderrDecoder.end();
          if (stdoutTail) {
            stdout = capture(stdout, stdoutTail);
            lines("stdout", stdoutTail);
          }
          if (stderrTail) {
            stderr = capture(stderr, stderrTail);
            lines("stderr", stderrTail);
          }
          if (result) {
            result.stdout = stdout;
            result.stderr = stderr;
          }
        }
        if (!outputError && options.onLine) {
          for (const stream of ["stdout", "stderr"] as const) {
            const pending = pendingLines[stream];
            if (pending.bytes) options.onLine(stream, pending.parts.join(""));
          }
        }
      } catch (lineError) {
        failOutput(lineError);
      }
      const closed = await Promise.allSettled([
        finishStream(stdoutStream),
        finishStream(stderrStream),
      ]);
      for (const result of closed) {
        if (result.status === "rejected") outputError ??= result.reason;
      }
      // Final line callbacks or log flushing can fail after the leader closes.
      // Await any cleanup those failures started before releasing the caller.
      try {
        await termination;
      } catch (terminationError) {
        cleanupError = terminationError as Error;
      }
      if (cleanupError) {
        reject(
          outputError
            ? new AggregateError(
                [outputError, cleanupError],
                `${outputError.message}; subprocess cleanup failed: ${cleanupError.message}`,
              )
            : cleanupError,
        );
        return;
      }
      if (outputError) {
        reject(outputError);
        return;
      }
      if (error) reject(error);
      else if (signal?.aborted) reject(signal.reason);
      else resolve(result!);
    };

    const stop = () => {
      if (termination !== undefined) return;
      termination = terminateProcessTree(child);
      void termination.then(
        () => {
          // A detached descendant outside our process group may have inherited
          // pipes. Once the owned tree has exited, those pipes cannot hold the
          // invocation open indefinitely.
          if (!settled) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.stdin.destroy();
            void finish({
              exitCode: child.exitCode,
              signal: child.signalCode,
              timedOut,
              stdout,
              stderr,
            });
          }
        },
        (error: Error) => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          child.unref();
          void finish(undefined, error);
        },
      );
    };
    const onAbort = () => stop();

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutSeconds * 1000);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      void finish(undefined, error);
    });
    child.on("close", (exitCode, signal) => {
      void finish({ exitCode, signal, timedOut, stdout, stderr });
    });

    // A fast-exiting process may close stdin before end() completes. Its exit
    // status is the useful result; avoid turning that common EPIPE into an
    // unhandled stream error.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
  });
}

export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  // Provider processes can invoke tools before their event stream is checked.
  // Start from an allowlist so arbitrary shell, CI, and project-.env secrets
  // are never available to those tools in the first place. Subscription auth
  // remains file-based: Codex uses HOME, while Claude and Grok replace HOME
  // with isolated directories containing only copied credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "no_proxy",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    const value = process.env[name];
    if (value === undefined) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Refusing to pass malformed provider proxy setting ${name}`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`Refusing to pass credential-bearing provider proxy setting ${name}`);
    }
    env[name] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

/**
 * Resolve the browser registry as Playwright would before a provider's HOME is
 * replaced with an isolated directory. Browser MCP servers inherit this value,
 * so they can use an existing `playwright install` without exposing the rest of
 * the user's home directory to provider-native configuration discovery.
 */
export function playwrightBrowsersPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === "0") return configured;
  if (configured) return path.resolve(environment.INIT_CWD ?? process.cwd(), configured);

  let cacheDirectory: string;
  if (process.platform === "linux") {
    cacheDirectory = environment.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  } else if (process.platform === "darwin") {
    cacheDirectory = path.join(os.homedir(), "Library", "Caches");
  } else {
    throw new Error(`Playwright is unsupported on platform ${process.platform}`);
  }
  return path.join(cacheDirectory, "ms-playwright");
}

export function parseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence) candidates.unshift(requireDefined(fence[1], "fence[1]"));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next exact representation. Deliberately avoid guessing at a
      // JSON substring: accepting surrounding prose hides malformed outputs.
    }
  }
  return undefined;
}

export function stringifyCommand(command: string, args: string[]): string[] {
  return [command, ...args];
}

const boundaryFlags: Record<"codex" | "claude" | "grok", Set<string>> = {
  codex: new Set([
    "--add-dir",
    "--approve-for-me",
    "--ask-for-approval",
    "--cd",
    "--config",
    "--dangerously-bypass-approvals-and-sandbox",
    "--full-auto",
    "--image",
    "--output-last-message",
    "--output-schema",
    "--profile",
    "--sandbox",
    "--search",
    "fork",
    "resume",
    "-a",
    "-c",
    "-C",
    "-i",
    "-p",
    "-s",
  ]),
  claude: new Set([
    "--add-dir",
    "--agent",
    "--agents",
    "--allowed-tools",
    "--allowedTools",
    "--append-system-prompt",
    "--append-system-prompt-file",
    "--bare",
    "--chrome",
    "--cloud",
    "--continue",
    "--dangerously-skip-permissions",
    "--disallowed-tools",
    "--disallowedTools",
    "--environment",
    "--file",
    "--fork-session",
    "--from-pr",
    "--mcp-config",
    "--permission-mode",
    "--permission-prompt-tool",
    "--plugin-dir",
    "--plugin-url",
    "--restore-code",
    "--resume",
    "--safe-mode",
    "--session-id",
    "--settings",
    "--setting-sources",
    "--strict-mcp-config",
    "--system-prompt",
    "--system-prompt-file",
    "--teleport",
    "--tools",
    "--worktree",
    "--worktree-ref",
    "-c",
    "-r",
    "-s",
    "-w",
  ]),
  grok: new Set([
    "--agent",
    "--agents",
    "--allow",
    "--allowedTools",
    "--always-approve",
    "--continue",
    "--cwd",
    "--disable-web-search",
    "--disallowed-tools",
    "--disallowedTools",
    "--fork-session",
    "--json-schema",
    "--leader-socket",
    "--mcp-config",
    "--permission-mode",
    "--prompt-file",
    "--prompt-json",
    "--restore-code",
    "--resume",
    "--rules",
    "--session-id",
    "--system-prompt",
    "--system-prompt-override",
    "--tools",
    "--worktree",
    "--worktree-ref",
    "--ref",
    "-c",
    "-r",
    "-s",
    "-w",
  ]),
};

/** Refuse additive or bypass flags that fixed options later in argv cannot undo. */
export function assertSafeProviderExtraArgs(
  provider: "codex" | "claude" | "grok",
  args: string[],
): void {
  const blocked = boundaryFlags[provider];
  for (const argument of args) {
    const flag = argument.startsWith("--") ? argument.split("=", 1).join("") : argument;
    const blockedShort = [...blocked].find(
      (candidate) => candidate.length === 2 && argument.startsWith(candidate),
    );
    if (argument === "-" || argument === "--" || blocked.has(flag) || blockedShort) {
      throw new Error(
        `${provider} extraArgs cannot include evidence-boundary option ${JSON.stringify(argument)}`,
      );
    }
  }
}
