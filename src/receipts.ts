import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { stableJson, sha256 } from "./io.js";
import type {
  ArtifactReceipt,
  EvalConfig,
  EvalSpec,
  EvalSplit,
  ProviderId,
  RunReceipt,
} from "./types.js";
import { KIT_VERSION } from "./version.js";

function bytesReceipt(value: string | Buffer): ArtifactReceipt {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { sha256: sha256(buffer), bytes: buffer.length };
}

function fileReceipt(file: string): ArtifactReceipt {
  return bytesReceipt(fs.readFileSync(file));
}

function commandText(command: string, args: string[], cwd?: string): string | undefined {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.slice(0, 300) || undefined;
}

function providerVersion(provider: ProviderId): string {
  if (provider === "mock") return `agent-eval-kit mock ${KIT_VERSION}`;
  const version = commandText(provider, ["--version"]);
  if (!version) {
    throw new Error(`Unable to determine ${provider} CLI version; run \`aek doctor\` and fix the provider installation before evaluating`);
  }
  return version;
}

function normalizedComparisonOrigins(config: EvalConfig, specs: EvalSpec[]): string[] {
  const usesBrowser = specs.some((spec) => spec.scenarios.some((scenario) =>
    (scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")) === "browser"
  ));
  if (!usesBrowser) return [];
  const primaryOrigin = config.target.url ? new URL(config.target.url).origin : undefined;
  const normalized = config.target.allowedOrigins.map((entry) => {
    if (!entry.includes("*")) return new URL(entry).origin;
    // URL canonicalization lower-cases hosts and removes default ports, but it
    // needs a real hostname in place of the wildcard while parsing.
    const marker = "aek-wildcard";
    const parsed = new URL(entry.replace("://*.", `://${marker}.`));
    const suffix = parsed.hostname.slice(marker.length + 1);
    return `${parsed.protocol}//*.${suffix}${parsed.port ? `:${parsed.port}` : ""}`;
  });
  // The primary deployment origin is target identity, not evaluator method:
  // baseline/candidate URLs may differ while using the same evidence policy.
  return [...new Set(normalized.filter((origin) => origin !== primaryOrigin))].sort();
}

function normalizedLifecycleCwd(config: EvalConfig, cwd: string | undefined): string {
  const root = path.resolve(config.project.root);
  const resolved = path.resolve(cwd ?? root);
  const relative = path.relative(root, resolved);
  if (!relative) return "project:.";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `project:${relative.split(path.sep).join("/")}`;
  }
  // An external working directory is part of the lifecycle contract. Unlike
  // a project-relative path, there is no deployment-independent identity we
  // can safely substitute for it.
  return `external:${resolved}`;
}

function normalizedLifecycleReadyUrl(config: EvalConfig, readyUrl: string): string {
  const ready = new URL(readyUrl);
  if (config.target.url && ready.origin === new URL(config.target.url).origin) {
    // Baseline and candidate deployments may intentionally use different
    // origins. Preserve the readiness route while abstracting only that
    // deployment identity.
    return `target-origin:${ready.pathname}${ready.search}${ready.hash}`;
  }
  return ready.toString();
}

function normalizedLifecyclePolicy(config: EvalConfig) {
  const command = (value: typeof config.target.setup) => value
    ? {
        command: value.command,
        cwd: normalizedLifecycleCwd(config, value.cwd),
        env: value.env,
        timeoutSeconds: value.timeoutSeconds,
      }
    : undefined;
  const ready = config.target.ready
    ? {
        url: config.target.ready.url
          ? normalizedLifecycleReadyUrl(config, config.target.ready.url)
          : undefined,
        command: config.target.ready.command,
        timeoutSeconds: config.target.ready.timeoutSeconds,
        intervalMs: config.target.ready.intervalMs,
      }
    : undefined;
  return {
    setup: command(config.target.setup),
    start: command(config.target.start),
    ready,
  };
}

function gitPathspecs(root: string, excludedPaths: string[]): string[] {
  const exclusions = excludedPaths.flatMap((candidate) => {
    const relative = path.relative(root, path.resolve(candidate)).split(path.sep).join("/");
    if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) return [];
    return [`:(exclude)${relative}`, `:(exclude)${relative}/**`];
  });
  return [".", ...exclusions];
}

function hashFile(file: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

const MAX_TARGET_ENTRIES = 100_000;
const MAX_TARGET_BYTES = 20 * 1024 * 1024 * 1024;

function nonGitTreeSha256(root: string, excludedPaths: string[]): string {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Non-Git project root must be a real directory: ${resolvedRoot}`);
  }
  const exclusions = excludedPaths.flatMap((candidate) => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolved);
    return !relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? []
      : [resolved];
  });
  const excluded = (candidate: string) => exclusions.some((prefix) =>
    candidate === prefix || candidate.startsWith(`${prefix}${path.sep}`)
  );
  const entries: Array<Record<string, string | number>> = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (excluded(absolute) || entry.name === ".git") continue;
      if (entries.length >= MAX_TARGET_ENTRIES) {
        throw new Error(`Non-Git target exceeds the ${MAX_TARGET_ENTRIES}-entry fingerprint limit; initialize Git or reduce project.root`);
      }
      const relative = path.relative(resolvedRoot, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, kind: "symlink", target: fs.readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory" });
        visit(absolute);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_TARGET_BYTES) {
          throw new Error(`Non-Git target exceeds the ${MAX_TARGET_BYTES}-byte fingerprint limit; initialize Git or reduce project.root`);
        }
        entries.push({ path: relative, kind: "file", mode: stat.mode & 0o777, bytes: stat.size, sha256: hashFile(absolute) });
      } else {
        entries.push({ path: relative, kind: "other" });
      }
    }
  };
  visit(resolvedRoot);
  return sha256(stableJson(entries));
}

function gitlinkEntry(root: string, relative: string): { mode: string; object: string } | undefined {
  const result = spawnSync("git", ["ls-files", "--stage", "-z", "--", relative], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect Git index entry ${relative}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  const match = /^(\d+) ([a-f0-9]+) \d+\t/.exec(result.stdout);
  return match?.[1] === "160000" ? { mode: match[1], object: match[2] } : undefined;
}

function gitRevision(root: string, excludedPaths: string[]): RunReceipt["target"]["git"] {
  const insideWorktree = commandText("git", ["rev-parse", "--is-inside-work-tree"], root);
  if (insideWorktree !== "true") return undefined;
  const resolvedCommit = commandText("git", ["rev-parse", "HEAD"], root);
  const commit = resolvedCommit && /^[a-f0-9]{40,64}$/i.test(resolvedCommit)
    ? resolvedCommit
    : "UNBORN";
  const pathspecs = gitPathspecs(root, excludedPaths);
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...pathspecs],
    { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (status.error || status.status !== 0) {
    throw new Error(`Unable to fingerprint Git target state: ${status.error?.message || status.stderr.trim() || `exit ${status.status}`}`);
  }
  // Git deliberately omits ignored files from both status and `ls-files -co`,
  // but ignored runtime inputs such as .env and local databases can materially
  // change the target being evaluated. Include them while excluding only
  // dependency/cache trees that are derived from tracked manifests. Build
  // outputs remain included because a configured start command may execute
  // them directly.
  const ignored = spawnSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...pathspecs,
      ...[
        "node_modules",
        ".pnpm-store",
        ".yarn",
        ".cache",
        ".turbo",
        ".venv",
        "venv",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        "coverage",
      ].map((directory) => `:(exclude,glob)**/${directory}/**`),
    ],
    { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (ignored.error || ignored.status !== 0) {
    throw new Error(`Unable to list ignored Git target inputs: ${ignored.error?.message || ignored.stderr.toString("utf8").trim() || `exit ${ignored.status}`}`);
  }
  const ignoredFiles = ignored.stdout.toString("utf8").split("\0").filter(Boolean);
  const dirty = Boolean(status.stdout.trim()) || ignoredFiles.length > 0;
  if (!dirty) return { commit, dirty: false };

  const listed = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z", "--", ...pathspecs],
    { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(`Unable to list Git target files: ${listed.error?.message || listed.stderr.toString("utf8").trim() || `exit ${listed.status}`}`);
  }
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  const files = [...new Set([
    ...listed.stdout.toString("utf8").split("\0").filter(Boolean),
    ...ignoredFiles,
  ])].sort();
  if (files.length > MAX_TARGET_ENTRIES) {
    throw new Error(`Git target exceeds the ${MAX_TARGET_ENTRIES}-entry fingerprint limit; reduce project.root`);
  }
  let totalBytes = 0;
  const worktree = files.map((relative) => {
    const absolute = path.resolve(root, ...relative.split("/"));
    if (!absolute.startsWith(rootPrefix)) return { path: relative, kind: "invalid" };
    if (!fs.existsSync(absolute)) return { path: relative, kind: "missing" };
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path: relative, kind: "symlink", target: fs.readlinkSync(absolute) };
    if (!stat.isFile()) {
      const gitlink = stat.isDirectory() ? gitlinkEntry(root, relative) : undefined;
      if (gitlink) {
        const nestedRoot = commandText("git", ["rev-parse", "--show-toplevel"], absolute);
        const initialized = Boolean(nestedRoot && path.resolve(nestedRoot) === absolute);
        return {
          path: relative,
          kind: "submodule",
          indexCommit: gitlink.object,
          checkout: initialized ? gitRevision(absolute, []) : undefined,
        };
      }
      return { path: relative, kind: "other" };
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TARGET_BYTES) {
      throw new Error(`Git target exceeds the ${MAX_TARGET_BYTES}-byte fingerprint limit; reduce project.root`);
    }
    return { path: relative, kind: "file", mode: stat.mode & 0o777, bytes: stat.size, sha256: hashFile(absolute) };
  });
  return { commit, dirty: true, worktreeSha256: sha256(stableJson(worktree)) };
}

function fixtureReceipts(file: string | undefined, fixtures: unknown): RunReceipt["inputs"]["fixtures"] {
  if (!file || !fs.existsSync(file)) return undefined;
  const configuredFiles = fixtures && typeof fixtures === "object" && !Array.isArray(fixtures)
    ? (fixtures as Record<string, unknown>).files
    : undefined;
  const files: Record<string, ArtifactReceipt & { configuredPath: string }> = Object.create(null);
  if (configuredFiles && typeof configuredFiles === "object" && !Array.isArray(configuredFiles)) {
    for (const [name, configuredPath] of Object.entries(configuredFiles)) {
      if (typeof configuredPath !== "string") continue;
      const resolved = path.resolve(path.dirname(file), configuredPath);
      files[name] = { configuredPath, ...fileReceipt(resolved) };
    }
  }
  return { manifest: fileReceipt(file), files };
}

export function buildRunReceipt(options: {
  config: EvalConfig;
  specs: EvalSpec[];
  fixtures: unknown;
  scenarioIds?: string[];
  split?: EvalSplit | "all";
  ignoredTargetPaths?: string[];
  /** Preserve the inputs that produced existing evidence during an offline rescore. */
  evidenceProvenance?: RunReceipt;
}): RunReceipt {
  const { config, specs, fixtures } = options;
  const specReceipts = Object.fromEntries(
    [...specs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((spec) => [spec.id, {
        // Rescore updates definition bytes but keeps pointing at the immutable
        // input snapshot captured by the original run.
        file: options.evidenceProvenance?.inputs.specs[spec.id]?.file ?? path.basename(spec.sourceFile),
        ...fileReceipt(spec.sourceFile),
      }]),
  );
  const fixtureReceipt = options.evidenceProvenance
    ? options.evidenceProvenance.inputs.fixtures
    : fixtureReceipts(config.paths.fixtures, fixtures);
  const providers: RunReceipt["providers"] = options.evidenceProvenance?.providers ?? (() => {
    const versions = new Map<ProviderId, string>();
    for (const provider of new Set([config.agent.provider, config.judge.provider])) {
      versions.set(provider, providerVersion(provider));
    }
    return {
      agent: { provider: config.agent.provider, model: config.agent.model, cliVersion: versions.get(config.agent.provider)! },
      judge: { provider: config.judge.provider, model: config.judge.model, cliVersion: versions.get(config.judge.provider)! },
    };
  })();
  const method = {
    kitVersion: KIT_VERSION,
    targetKind: config.target.kind,
    lifecycle: normalizedLifecyclePolicy(config),
    additionalAllowedOrigins: normalizedComparisonOrigins(config, specs),
    agent: config.agent,
    judge: config.judge,
    browser: config.browser,
    scoring: config.scoring,
    variables: config.variables,
    instructions: config.instructions,
    providerVersions: providers,
  };
  const methodSha256 = sha256(stableJson(method));
  const selection = {
    areas: specs.map((spec) => spec.id).sort(),
    scenarios: options.scenarioIds ? [...new Set(options.scenarioIds)].sort() : undefined,
    split: options.split && options.split !== "all" ? options.split : undefined,
  };
  const definition = {
    methodSha256,
    specs: Object.fromEntries(Object.entries(specReceipts).map(([id, receipt]) => [id, receipt.sha256])),
    fixtures: fixtureReceipt
      ? {
          manifest: fixtureReceipt.manifest.sha256,
          files: Object.fromEntries(Object.entries(fixtureReceipt.files).map(([name, receipt]) => [name, receipt.sha256])),
        }
      : undefined,
    selection,
  };
  const evaluationFingerprint = sha256(stableJson(definition));
  const configReceipt = options.evidenceProvenance?.inputs.config ?? bytesReceipt(stableJson(config));
  const target: RunReceipt["target"] = options.evidenceProvenance?.target ?? (() => {
    const managedRoot = path.dirname(config.paths.runs);
    const managedRoots = path.basename(managedRoot) === ".agent-eval" ? [managedRoot] : [];
    const excludedTargetPaths = [
      config.paths.runs,
      config.paths.auth,
      ...(config.paths.baselines ? [config.paths.baselines] : []),
      ...managedRoots,
      ...(options.ignoredTargetPaths ?? []),
    ];
    const git = gitRevision(config.project.root, excludedTargetPaths);
    return {
      kind: config.target.kind,
      url: config.target.url,
      git,
      treeSha256: git ? undefined : nonGitTreeSha256(config.project.root, excludedTargetPaths),
    };
  })();
  return {
    schemaVersion: 1,
    evaluationFingerprint,
    inputFingerprint: sha256(stableJson({
      evaluationFingerprint,
      configSha256: configReceipt.sha256,
      target,
    })),
    inputs: {
      config: configReceipt,
      methodSha256,
      specs: specReceipts,
      fixtures: fixtureReceipt,
      selection,
    },
    target,
    providers,
    runtime: {
      kitVersion: KIT_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}
