import type { TextPairwiseGrader } from "./text/contracts.js";
import type { CaptureConfig, CaptureCheck, DiagnosticPolicy, BrowserDiagnostic, PairwiseGrader, VotingPolicy, VoteSummary, DistinctnessGrader, ImageRegressionGrader } from "./visual/contracts.js";
export const PROVIDERS = ["codex", "claude", "grok", "mock"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export type TargetKind = "web" | "repository" | "command";
export type ScenarioKind = "browser" | "workspace" | "command";
export type EvalSplit = "development" | "evaluation";
export type Verdict = "pass" | "partial" | "fail" | "not_found" | "cannot_judge";
export type ScenarioOutcome = "completed" | "blocked" | "feature_not_found" | "agent_error";

export interface CommandConfig {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface ProviderConfig {
  provider: ProviderId;
  model?: string;
  effort?: string;
  maxTurns?: number;
  timeoutSeconds: number;
  extraArgs: string[];
}

export interface EvalConfig {
  version: 1;
  project: {
    name: string;
    root: string;
  };
  target: {
    kind: TargetKind;
    url?: string;
    allowedOrigins: string[];
    setup?: CommandConfig;
    start?: CommandConfig;
    allowExternalServer?: boolean;
    ready?: {
      url?: string;
      command?: string;
      timeoutSeconds: number;
      intervalMs: number;
    };
  };
  agent: ProviderConfig;
  judge: ProviderConfig & { voting?: VotingPolicy; concurrency?: number };
  paths: {
    specs: string;
    fixtures?: string;
    runs: string;
    auth: string;
    /** Commit-friendly promoted comparison snapshots. */
    baselines?: string;
  };
  browser: {
    headless: boolean;
    viewport: { width: number; height: number };
    actionTimeoutMs: number;
    diagnostics?: DiagnosticPolicy;
    screenshotFormat?: "jpeg" | "png";
  };
  scoring: {
    partialCredit: number;
    minimumCoverage: number;
  };
  variables: Record<string, unknown>;
  instructions?: string;
}

export interface Scenario {
  id: string;
  name: string;
  kind?: ScenarioKind;
  persona?: string;
  instructions: string;
  successSignals: string[];
  dependsOn: string[];
  requiresAuth: boolean;
  /** Optional split for a non-matrix scenario. Unset scenarios run in every split. */
  split?: EvalSplit;
  /** Parameterized variants of this scenario. */
  cases?: ScenarioCase[];
  capture?: CaptureConfig;
  collect?: {
    command: string;
    methodFiles: string[];
    timeoutSeconds: number;
    sources: Record<string, string>;
    images: string[];
  };
  /** Populated only on a materialized scenario instance. */
  sourceScenarioId?: string;
  /** Populated only on a materialized matrix case. */
  caseId?: string;
  caseVariables?: Record<string, unknown>;
  strata?: string[];
}

export interface ScenarioCase {
  id: string;
  name?: string;
  variables: Record<string, unknown>;
  /** Normalized dimension=value labels used for diagnostic slices. */
  strata: string[];
  split?: EvalSplit;
}

export interface CommandGrader {
  type: "command";
  /** Checker code and expected data, resolved from project.root. Empty for inline checks. */
  methodFiles: string[];
  output: "json" | "exit-code";
  command: string;
  cwd?: "project" | "run" | string;
  timeoutSeconds?: number;
}

export interface LlmGrader {
  type: "llm";
}

export interface ManualGrader {
  type: "manual";
}

export interface HybridGrader {
  type: "hybrid";
  /** Fraction of item weight awarded by the automatic judge; remainder is manual. */
  autoShare: number;
}

export type Grader = TextPairwiseGrader | CommandGrader | LlmGrader | ManualGrader | HybridGrader | PairwiseGrader | DistinctnessGrader | ImageRegressionGrader | { type: "capture" };

export interface RubricItem {
  id: string;
  criterion: string;
  weight: number;
  tags: string[];
  scenarios: string[];
  grader: Grader;
  passCriteria: string;
  evidence?: string;
  manualInstructions?: string;
  /** A critical item that must pass regardless of the aggregate score. */
  gate?: boolean;
}

export interface EvalSpec {
  id: string;
  title: string;
  weight: number;
  optional: boolean;
  description: string;
  scenarios: Scenario[];
  rubric: RubricItem[];
  sourceFile: string;
}

export interface TranscriptEntry {
  step: number;
  at: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

export interface ScreenshotRef {
  path: string;
  label: string;
  step: number;
  url?: string;
  timeSeconds?: number;
  source?: string;
  extraction?: string;
}

/** Raw structured provider telemetry; values are not limited to token counts. */
export type ProviderUsage = Record<string, unknown>;

export interface ScenarioEvidence {
  scenarioId: string;
  scenarioName: string;
  kind: ScenarioKind;
  persona?: string;
  sourceScenarioId?: string;
  caseId?: string;
  strata?: string[];
  split?: EvalSplit;
  outcome: ScenarioOutcome;
  summary: string;
  observations: string[];
  evidenceRefs: string[];
  transcript: TranscriptEntry[];
  screenshots: ScreenshotRef[];
  /** Paths relative to this scenario directory. */
  artifacts: Record<string, string>;
  collector?: "controlled" | "command";
  captureChecks?: CaptureCheck[];
  diagnostics?: BrowserDiagnostic[];
  provider: ProviderId;
  model?: string;
  providerSessionId?: string;
  usage?: ProviderUsage;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  finalUrl?: string;
  error?: string;
}

export interface JudgedCase {
  areaId: string;
  rubricId: string;
  caseId: string;
  scenarioIds: string[];
  strata: string[];
  split?: EvalSplit;
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  evidenceRefs: string[];
  source: "llm" | "pairwise";
  /** Numeric value under this run's configured partial-credit rule. */
  points?: number | null;
}

export interface JudgedItem {
  id: string;
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  evidenceRefs: string[];
  source: "text-pairwise" | "llm" | "command" | "manual" | "pairwise" | "capture" | "image-distinctness" | "image-regression";
  votes?: VoteSummary;
  comparisons?: string[];
  /** Populated by scoreArea, using the actual weights and evidence coverage. */
  score?: ScoreSlice;
  components?: {
    automatic?: Verdict;
    manual?: Verdict;
  };
}

export interface GateResult {
  itemId: string;
  status: "passed" | "failed" | "unavailable";
  verdict?: Verdict;
  reason: string;
}

export interface ArtifactReceipt {
  sha256: string;
  bytes: number;
}

export interface RunReceipt {
  schemaVersion: 1;
  evaluationFingerprint: string;
  inputFingerprint: string;
  inputs: {
    config: ArtifactReceipt;
    methodSha256: string;
    visual?: Record<string, ArtifactReceipt>;
    textCandidates?: Record<string, ArtifactReceipt>;
    textReferences?: Record<string, ArtifactReceipt>;
    collectorSources?: Record<string, ArtifactReceipt>;
    collectorMethods?: Record<string, ArtifactReceipt>;
    graderMethods?: Record<string, ArtifactReceipt>;
    specs: Record<string, ArtifactReceipt & { file: string }>;
    fixtures?: {
      manifest: ArtifactReceipt;
      files: Record<string, ArtifactReceipt & { configuredPath: string }>;
    };
    selection: { areas: string[]; scenarios?: string[]; split?: EvalSplit | "all" };
  };
  target: {
    kind: TargetKind;
    url?: string;
    git?: { commit: string; dirty: boolean; worktreeSha256?: string };
    /** Deterministic project-content hash used when project.root is not a Git worktree. */
    treeSha256?: string;
  };
  providers: {
    agent: { provider: ProviderId; model?: string; cliVersion: string };
    judge: { provider: ProviderId; model?: string; cliVersion: string };
  };
  runtime: { kitVersion: string; node: string; platform: NodeJS.Platform; arch: string; evidence?: { chromium?: string; playwright: string; sharp: Record<string, string> } };
}

export interface Defect {
  region?: { x: number; y: number; width: number; height: number };
  severity: "critical" | "major" | "minor";
  description: string;
  evidenceRefs: string[];
}

export interface ScoreSlice {
  /** Full-precision weights; only percentages are rounded for reporting. */
  earned: number;
  judgeable: number;
  total: number;
  scorePct: number | null;
  coveragePct: number;
}

export interface AreaResult extends ScoreSlice {
  id: string;
  title: string;
  weight: number;
  optional: boolean;
  items: JudgedItem[];
  defects: Defect[];
  notes: string;
  scenarios: ScenarioEvidence[];
  pendingManual: string[];
  unproven: string[];
  byTag: Record<string, ScoreSlice>;
  byStratum: Record<string, ScoreSlice & { cases: number }>;
  gates: GateResult[];
  /** Per-case judgements support stability and paired campaign analysis. */
  caseResults: JudgedCase[];
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  project: string;
  target: { kind: TargetKind; url?: string; root: string };
  startedAt: string;
  finishedAt: string;
  kitVersion: string;
  providers: {
    agent: { provider: ProviderId; model?: string };
    judge: { provider: ProviderId; model?: string };
  };
  areas: AreaResult[];
  overallScorePct: number | null;
  overallCoveragePct: number;
  scoreWithheld: boolean;
  byTag: Record<string, ScoreSlice>;
  byStratum: Record<string, ScoreSlice & { cases: number }>;
  manualPending: number;
  receipt: RunReceipt;
  gates: {
    passed: boolean;
    blocking: Array<GateResult & { areaId: string }>;
  };
}

export interface ProviderInvocation {
  purpose: "scenario" | "judge";
  cwd: string;
  promptFile: string;
  outputFile: string;
  outputSchemaFile: string;
  eventLogFile: string;
  stderrFile: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  timeoutSeconds: number;
  extraArgs: string[];
  images?: string[];
  additionalDirs?: string[];
  mcp?: {
    name: string;
    command: string;
    args: string[];
    configFile: string;
    toolNames: string[];
  };
  allowWorkspaceTools: boolean;
  onProgress?: (message: string) => void;
}

export interface ProviderResult {
  provider: ProviderId;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  finalText: string;
  structured?: unknown;
  sessionId?: string;
  usage?: ProviderUsage;
  command: string[];
  policyViolations?: string[];
}
