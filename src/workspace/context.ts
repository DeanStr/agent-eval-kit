import type { Scenario } from "../types.js";
export interface WorkspaceMcpContext {
  outputs?: Scenario["outputs"];
  checkpoints?: Scenario["checkpoints"];
  requiredCheckpoints?: string[];
  projectRoot: string;
  evidenceDir: string;
  /** Codex has no provider turn limit, so its maxTurns is enforced here. */
  maxToolCalls?: number;
  /** Config, specs, and other evaluator-only paths hidden from the collector. */
  evaluatorOnlyPaths?: string[];
}

export interface WorkspaceResultState {
  outcome: "completed" | "blocked" | "feature_not_found";
  summary: string;
  observations: string[];
  finishedAt: string;
}
