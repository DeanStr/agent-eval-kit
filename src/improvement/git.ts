import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** No shell, hooks, or caller-supplied Git index/worktree overrides. */
export function git(root: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "AEK checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@aek.invalid",
        GIT_COMMITTER_NAME: "AEK checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@aek.invalid",
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    const detail = error as { stderr?: Buffer | string };
    throw new Error(`Git ${args[0]} failed: ${String(detail.stderr ?? error).trim()}`);
  }
}

export function assertClean(root: string): void {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"]))
    throw new Error(
      "Improvement requires a clean Git checkout. Commit the intended project and evaluation files first; unrelated changes are never stashed automatically.",
    );
}

export function assertNoSubmodules(root: string, env: NodeJS.ProcessEnv = {}): void {
  const gitlink = git(root, ["ls-files", "--stage", "-z"], env)
    .split("\0")
    .find((entry) => entry.startsWith("160000 "));
  if (gitlink)
    throw new Error(
      `Improvement checkpoints do not support Git submodules or embedded repositories: ${JSON.stringify(gitlink.slice(gitlink.indexOf("\t") + 1))}. Vendor the files as regular tracked files before retrying.`,
    );
}

/** Private index snapshots tracked and nonignored new files without changing the real index. */
export function workingTree(root: string, session: string): string {
  const index = path.join(session, `.index-${crypto.randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", "--all", "--", "."], env);
    assertNoSubmodules(root, env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}

export function checkpoint(root: string, session: string, ref: string, message: string): string {
  const tree = workingTree(root, session);
  const commit = git(root, ["commit-tree", tree, "-p", "HEAD", "-m", message]);
  git(root, ["update-ref", ref, commit]);
  return commit;
}

/** Only called after validating ownership and retaining the current candidate. */
export function restore(root: string, commit: string): void {
  git(root, ["reset", "--hard", commit]);
  git(root, ["clean", "-fd"]); // Ignored dependencies, credentials and generated artifacts remain.
  assertClean(root);
}
