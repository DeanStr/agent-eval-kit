import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

const MAX_CAPTURE = 12 * 1024 * 1024;

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
  let outputError: Error | undefined;
  stdoutStream.on("error", (error) => {
    outputError ??= error;
  });
  stderrStream.on("error", (error) => {
    outputError ??= error;
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let stderrRemainder = "";
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
      return /[\uDC00-\uDFFF]/.test(clipped[0]) ? clipped.slice(1) : clipped;
    };
    const lines = (stream: "stdout" | "stderr", chunk: string) => {
      let buffer = (stream === "stdout" ? stdoutRemainder : stderrRemainder) + chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      if (stream === "stdout") stdoutRemainder = buffer;
      else stderrRemainder = buffer;
      for (const line of parts) options.onLine?.(stream, line);
    };

    child.stdout.on("data", (data: Buffer) => {
      stdoutStream.write(data);
      const chunk = stdoutDecoder.write(data);
      stdout = capture(stdout, chunk);
      lines("stdout", chunk);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrStream.write(data);
      const chunk = stderrDecoder.write(data);
      stderr = capture(stderr, chunk);
      lines("stderr", chunk);
    });
    const finishStream = (stream: fs.WriteStream) =>
      new Promise<void>((streamResolve, streamReject) => {
        if (stream.closed) {
          streamResolve();
          return;
        }
        stream.once("error", streamReject);
        stream.once("close", streamResolve);
        stream.end();
      });

    const finish = async (result: SpawnResult | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A closed leader does not imply its descendants exited. Keep the
      // escalation alive and await it before returning or removing isolation.
      try {
        await termination;
      } catch (terminationError) {
        error = terminationError as Error;
      }
      signal?.removeEventListener("abort", onAbort);
      if (!decodersFlushed) {
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
      if (stdoutRemainder) options.onLine?.("stdout", stdoutRemainder);
      if (stderrRemainder) options.onLine?.("stderr", stderrRemainder);
      try {
        await Promise.all([finishStream(stdoutStream), finishStream(stderrStream)]);
      } catch (streamError) {
        reject(streamError);
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
      if (termination) return;
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
  if (fence) candidates.unshift(fence[1]);
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
    const flag = argument.startsWith("--") ? argument.split("=", 1)[0] : argument;
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
