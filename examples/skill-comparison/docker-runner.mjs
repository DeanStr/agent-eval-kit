import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export function validateControls(controls) {
  const keys = [
    "image",
    "model",
    "effort",
    "timeoutSeconds",
    "repetitions",
    "authFile",
    "network",
    "proxyUrl",
  ];
  if (!controls || Object.keys(controls).some((key) => !keys.includes(key)))
    throw new Error(`Controls must contain only ${keys.join(", ")}`);
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(controls.image ?? ""))
    throw new Error("Pin the installed runner image by its sha256 digest");
  if (typeof controls.model !== "string" || !controls.model.trim())
    throw new Error("Specify a fixed candidate model");
  if (!["low", "medium", "high"].includes(controls.effort)) throw new Error("Invalid effort");
  if (
    !Number.isInteger(controls.timeoutSeconds) ||
    controls.timeoutSeconds < 1 ||
    controls.timeoutSeconds > 3600
  )
    throw new Error("timeoutSeconds must be an integer from 1 to 3600");
  if (!Number.isInteger(controls.repetitions) || controls.repetitions < 2)
    throw new Error("Use at least two fresh candidate repetitions per variant");
  if (typeof controls.authFile !== "string" || !path.isAbsolute(controls.authFile))
    throw new Error("authFile must be an absolute path to runner credentials");
  if (
    !/^[a-z][a-z0-9_-]+$/.test(controls.network ?? "") ||
    ["host", "bridge", "none", "default"].includes(controls.network)
  )
    throw new Error("Specify a dedicated internal Docker network for model-only proxy access");
  if (typeof controls.proxyUrl !== "string" || !URL.canParse(controls.proxyUrl))
    throw new Error("Specify proxyUrl for the allowlisted model-only HTTP(S) proxy");
  const proxy = new URL(controls.proxyUrl);
  if (!["http:", "https:"].includes(proxy.protocol) || proxy.username || proxy.password)
    throw new Error("proxyUrl must be an HTTP(S) model-only proxy without embedded credentials");
  return controls;
}

export async function capture(command, args, { cwd, input, timeoutSeconds, directory, prefix }) {
  const started = performance.now();
  const stdout = fs.openSync(path.join(directory, `${prefix}.stdout`), "w");
  let stderr;
  try {
    stderr = fs.openSync(path.join(directory, `${prefix}.stderr`), "w");
    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const errors = [];
      let interruptedSignal;
      let forceStop;
      const interrupt = (signal) => {
        if (interruptedSignal) {
          child.kill("SIGKILL");
          return;
        }
        interruptedSignal = signal;
        errors.push(`Execution interrupted by ${signal}`);
        // Docker cleanup runs in runContainer's finally. Give an AEK subprocess
        // time to cancel its own collectors before forcing it to stop.
        child.kill(command === "docker" ? "SIGKILL" : "SIGTERM");
        if (command !== "docker") forceStop = setTimeout(() => child.kill("SIGKILL"), 10_000);
      };
      const onInterrupt = () => interrupt("SIGINT");
      const onTerminate = () => interrupt("SIGTERM");
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      const deadline = setTimeout(() => {
        errors.push(`Execution exceeded ${timeoutSeconds}s (ETIMEDOUT)`);
        child.kill("SIGKILL");
      }, timeoutSeconds * 1000);
      const retain = (stream, file, label) => {
        let bytes = 0;
        let truncated = false;
        stream.on("data", (chunk) => {
          if (truncated) return;
          const remaining = 16 * 1024 * 1024 - bytes;
          try {
            const retained = chunk.subarray(0, remaining);
            fs.writeFileSync(file, retained);
            bytes += retained.length;
            if (chunk.length > remaining) {
              truncated = true;
              errors.push(`${label} exceeded the 16 MiB output limit`);
              child.kill("SIGKILL");
            }
          } catch (error) {
            errors.push(`Could not retain ${label}: ${error.message}`);
            child.kill("SIGKILL");
          }
        });
      };
      retain(child.stdout, stdout, "stdout");
      retain(child.stderr, stderr, "stderr");
      child.on("error", (error) => errors.push(error.message));
      child.stdin.on("error", (error) =>
        errors.push(`Could not send command input: ${error.message}`),
      );
      child.on("close", (exitCode, signal) => {
        clearTimeout(deadline);
        clearTimeout(forceStop);
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        resolve({
          exitCode,
          signal,
          durationMs: Math.round(performance.now() - started),
          ...(interruptedSignal ? { interruptedSignal } : {}),
          ...(errors.length ? { error: errors.join("; ") } : {}),
        });
      });
      child.stdin.end(input);
    });
  } finally {
    fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
}

export function mount(source, target, readonly = false) {
  if (/[\n\r,]/.test(source))
    throw new Error("Docker mount paths cannot contain commas or newlines");
  return `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ",readonly" : ""}`;
}

export function containerArgs(name) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1g",
    "--cpus=1",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m,mode=1777",
    "-i",
  ];
}

// Both execution boundaries must account for failed cleanup, even after a valid
// command result. Keep primary execution diagnostics alongside cleanup failures.
export async function runContainer(name, args, options) {
  let result;
  let cleanup;
  try {
    result = await capture("docker", args, options);
  } finally {
    cleanup = await capture("docker", ["rm", "-f", name], {
      directory: options.directory,
      prefix: `${options.prefix}-cleanup`,
      timeoutSeconds: 10,
    });
  }
  if (
    cleanup.error ||
    (cleanup.exitCode !== 0 &&
      !/No such container/i.test(
        fs.readFileSync(path.join(options.directory, `${options.prefix}-cleanup.stderr`), "utf8"),
      ))
  ) {
    result.cleanupError = `Failed to remove container ${name}; inspect ${options.prefix}-cleanup.stderr`;
    result.error = [result.error, result.cleanupError].filter(Boolean).join("; ");
  }
  result.cleanup = cleanup;
  if (!result.interruptedSignal && cleanup.interruptedSignal)
    result.interruptedSignal = cleanup.interruptedSignal;
  return result;
}

// One external candidate adapter. AEK never launches a candidate as a scenario.
export async function runCandidate({ workspace, directory, controls, instructions }) {
  validateControls(controls);
  const network = await capture(
    "docker",
    ["network", "inspect", "--format", "{{json .Internal}}", controls.network],
    { directory, prefix: "network", timeoutSeconds: 10 },
  );
  if (
    network.error ||
    network.exitCode !== 0 ||
    fs.readFileSync(path.join(directory, "network.stdout"), "utf8").trim() !== "true"
  )
    throw Object.assign(
      new Error(
        "Candidate network must exist and be internal; configure an allowlisted model-only proxy on it",
      ),
      { interruptedSignal: network.interruptedSignal },
    );
  const name = `aek-candidate-${randomUUID()}`;
  const args = [
    ...containerArgs(name),
    "--network",
    controls.network,
    "--mount",
    mount(workspace, "/workspace"),
    "--mount",
    mount(controls.authFile, "/runner-auth.json", true),
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/tmp",
    "--env",
    "CODEX_HOME=/tmp/codex",
    "--env",
    `HTTPS_PROXY=${controls.proxyUrl}`,
    "--env",
    `HTTP_PROXY=${controls.proxyUrl}`,
    "--entrypoint",
    "/bin/sh",
    controls.image,
    "-c",
    'mkdir -p /tmp/codex && cp /runner-auth.json /tmp/codex/auth.json && exec codex "$@"',
    "runner",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
    "--model",
    controls.model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(controls.effort)}`,
    "--config",
    'web_search="disabled"',
    "--sandbox",
    "danger-full-access",
    "--cd",
    "/workspace",
    "-",
  ];
  fs.writeFileSync(
    path.join(directory, "candidate-command.json"),
    JSON.stringify(["docker", ...args], null, 2),
  );
  const result = await runContainer(name, args, {
    cwd: workspace,
    directory,
    prefix: "candidate",
    timeoutSeconds: controls.timeoutSeconds,
    input: `Read TASK.md and complete its task.\n\n${instructions}`,
  });
  const events = fs
    .readFileSync(path.join(directory, "candidate.stdout"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  let usage = null;
  try {
    const parsed = events.map((line) => JSON.parse(line));
    const completed = parsed.filter((event) => event.type === "turn.completed");
    if (
      result.exitCode === 0 &&
      (completed.length !== 1 ||
        parsed.some((event) => ["error", "turn.failed"].includes(event.type)))
    )
      throw new Error("Candidate must complete exactly one turn without error events");
    usage = completed[0]?.usage ?? null;
  } catch (error) {
    result.error = [result.error, `Invalid candidate event stream: ${error.message}`]
      .filter(Boolean)
      .join("; ");
  }
  return {
    ...result,
    usage,
    observedCostUsd: null,
    costNote:
      "Subscription runner does not report per-attempt monetary cost; no estimate substituted.",
  };
}
