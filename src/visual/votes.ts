import fs from "node:fs";
import path from "node:path";
import { sha256, stableJson, writeJson } from "../io.js";
import { throwIfCancelled } from "../cancellation.js";
import type { VotingPolicy, VoteSummary } from "./contracts.js";
import type { Verdict } from "../types.js";

const voteOutcomes = new Set([
  "pass",
  "partial",
  "fail",
  "not_found",
  "win",
  "loss",
  "equivalent",
  "abstain",
]);

export function rubricVoteVerdict(decision: string): Verdict {
  switch (decision) {
    case "pass":
    case "partial":
    case "fail":
    case "not_found":
      return decision;
    case "inconclusive":
      return "cannot_judge";
    default:
      throw new Error(`Unexpected terminal rubric vote decision: ${decision}`);
  }
}

export function pairwiseVoteVerdict(
  decision: string,
  policy: "preference" | "non_regression",
): Verdict {
  switch (decision) {
    case "pass":
      return "pass";
    case "loss":
      return "fail";
    case "equivalent":
      if (policy === "preference") return "fail";
      throw new Error(
        "Unexpected equivalent decision for non_regression: accepted equivalence must yield pass",
      );
    case "inconclusive":
      return "cannot_judge";
    default:
      throw new Error(`Unexpected terminal pairwise vote decision: ${decision}`);
  }
}

/** Abstentions remain in the denominator. Equivalent is an observed result. */
export function decideVotes(
  outcomes: string[],
  policy: VotingPolicy,
  accept: string[],
): VoteSummary {
  for (const outcome of outcomes)
    if (!voteOutcomes.has(outcome)) throw new Error(`Unexpected vote outcome: ${outcome}`);
  if (
    !accept.length ||
    new Set(accept).size !== accept.length ||
    accept.some((outcome) => !voteOutcomes.has(outcome) || outcome === "abstain")
  )
    throw new Error("Invalid accepted vote outcomes");
  if (outcomes.length > policy.maximumVotes) throw new Error("Vote count exceeds maximumVotes");
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  const attempted = outcomes.length,
    judgeable = attempted - (counts.abstain ?? 0);
  const needed = Math.ceil(attempted * policy.agreement);
  let decision = "continue";
  if (attempted >= policy.minimumVotes) {
    const accepted = accept.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    if (accepted >= needed) decision = "pass";
    else {
      const winner = Object.keys(counts).find(
        (key) => key !== "abstain" && !accept.includes(key) && counts[key] >= needed,
      );
      if (winner) decision = winner;
    }
    if (decision === "continue" && attempted >= policy.maximumVotes) decision = "inconclusive";
  }
  return { attempted, judgeable, counts, decision };
}

/** Each completed vote has a content-checked receipt, committed before sealing. */
export async function journalVote<T>(options: {
  directory: string;
  identity: unknown;
  run: (directory: string) => Promise<T>;
  validate: (value: unknown) => T;
  seal?: () => void;
}): Promise<T> {
  throwIfCancelled();
  const { directory } = options;
  const fingerprint = sha256(stableJson(options.identity));
  const receiptFile = path.join(directory, "vote.json");
  if (fs.existsSync(receiptFile)) {
    const saved = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    if (saved.fingerprint !== fingerprint)
      throw new Error(`Vote inputs changed: ${directory}. Start a new run.`);
    if (saved.resultSha256 !== sha256(stableJson(saved.result)))
      throw new Error(`Vote result checksum changed: ${directory}`);
    for (const [name, hash] of Object.entries(saved.files as Record<string, string>)) {
      if (
        name.includes("..") ||
        path.isAbsolute(name) ||
        sha256(fs.readFileSync(path.join(directory, name))) !== hash
      )
        throw new Error(`Vote evidence checksum changed: ${directory}`);
    }
    return options.validate(saved.result);
  }
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const result = options.validate(await options.run(directory));
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Vote artifacts cannot be symbolic links");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        files[path.relative(directory, file)] = sha256(fs.readFileSync(file));
    }
  };
  visit(directory);
  writeJson(receiptFile, { fingerprint, result, resultSha256: sha256(stableJson(result)), files });
  options.seal?.();
  return result;
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Judge concurrency must be an integer from 1 to 8");
  const results: R[] = new Array(items.length);
  let next = 0,
    failed = false,
    error: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          throwIfCancelled();
          results[index] = await worker(items[index], index);
        } catch (cause) {
          if (!failed) error = cause;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw error;
  return results;
}

export function pairOutcome(
  result: { preferred: "A" | "B" | "equivalent" | "abstain"; confidence: number },
  candidateIsA: boolean,
  minimumConfidence: number,
): string {
  if (result.preferred === "abstain" || result.confidence < minimumConfidence) return "abstain";
  if (result.preferred === "equivalent") return "equivalent";
  return result.preferred === (candidateIsA ? "A" : "B") ? "win" : "loss";
}
