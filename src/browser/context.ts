export interface BrowserMcpContext {
  targetUrl: string;
  allowedOrigins: string[];
  evidenceDir: string;
  /** Previously trusted state to load at browser startup. */
  storageStatePath?: string;
  /** Scenario-local state written by the MCP and promoted only after provider success. */
  storageStateCandidatePath?: string;
  /** True only when this scenario requires a previously authenticated persona. */
  expectAuthenticated: boolean;
  fixtureFiles: Record<string, string>;
  headless: boolean;
  viewport: { width: number; height: number };
  actionTimeoutMs: number;
  screenshotFormat?: "jpeg" | "png";
  /** Codex has no provider turn limit, so its maxTurns is enforced here. */
  maxToolCalls?: number;
}

export interface BrowserResultState {
  outcome: "completed" | "blocked" | "feature_not_found";
  summary: string;
  observations: string[];
  finalUrl?: string;
  finishedAt: string;
}

export function browserActionResultIsError(result: string): boolean {
  return /^(?:ERROR|BLOCKED):/m.test(result);
}
