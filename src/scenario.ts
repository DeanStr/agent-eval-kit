import { validateOutputs } from "./workflow.js";
import { collectCommand } from "./collectors/command.js";
import { controlledCapture } from "./visual/capture.js";
import { readDiagnostics } from "./browser/diagnostics.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { personaAuthPath } from "./auth.js";
import type { BrowserMcpContext, BrowserResultState } from "./browser/context.js";
import { readJson, readNdjson, safeName, writeJson } from "./io.js";
import {
  BROWSER_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
  browserMcpLaunch,
  workspaceMcpLaunch,
  writeMcpConfig,
} from "./mcp-config.js";
import { scenarioPrompt } from "./prompts.js";
import { runProvider } from "./providers/index.js";
import { scenarioOutputSchema, scenarioOutputValidator } from "./schemas.js";
import type { WorkspaceMcpContext, WorkspaceResultState } from "./workspace/context.js";
import type {
  EvalConfig,
  EvalSpec,
  ProviderInvocation,
  Scenario,
  ScenarioEvidence,
  ScreenshotRef,
  TranscriptEntry,
} from "./types.js";

function fixtureFiles(fixtures: unknown, fixtureSource: string | undefined, projectRoot: string) {
  if (!fixtures || typeof fixtures !== "object") return {};
  const files = (fixtures as Record<string, unknown>).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return {};
  const base = fixtureSource ? path.dirname(fixtureSource) : projectRoot;
  return Object.fromEntries(
    Object.entries(files as Record<string, unknown>).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, path.resolve(base, value)]] : [],
    ),
  );
}

function chainStorageStatePath(
  spec: EvalSpec,
  scenario: Scenario,
  directory: string,
): string | undefined {
  const participatesInChain =
    scenario.dependsOn.length > 0 || spec.scenarios.some((candidate) => candidate.dependsOn.includes(scenario.id));
  if (!participatesInChain) return undefined;

  const component = new Set([scenario.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of spec.scenarios) {
      const connected = component.has(candidate.id) || candidate.dependsOn.some((id) => component.has(id));
      if (!connected) continue;
      for (const id of [candidate.id, ...candidate.dependsOn]) {
        if (!component.has(id)) {
          component.add(id);
          changed = true;
        }
      }
    }
  }
  const chain = [...component].sort()[0];
  return path.join(path.dirname(directory), ".state", safeName(spec.id), `${safeName(chain)}.json`);
}

function readToolArtifacts(directory: string, kind: "browser" | "workspace"): {
  result?: BrowserResultState | WorkspaceResultState;
  observations: string[];
  screenshots: ScreenshotRef[];
  transcript: TranscriptEntry[];
} {
  const resultFile = path.join(directory, `${kind}-result.json`);
  const observationsFile = path.join(directory, "observations.json");
  const screenshotsFile = path.join(directory, "screenshots.json");
  return {
    result: fs.existsSync(resultFile)
      ? readJson<BrowserResultState | WorkspaceResultState>(resultFile)
      : undefined,
    observations: fs.existsSync(observationsFile) ? readJson<string[]>(observationsFile) : [],
    screenshots: fs.existsSync(screenshotsFile) ? readJson<ScreenshotRef[]>(screenshotsFile) : [],
    transcript: readNdjson<TranscriptEntry>(path.join(directory, `${kind}-transcript.ndjson`)),
  };
}

export async function executeScenario(options: {
  config: EvalConfig;
  spec: EvalSpec;
  scenario: Scenario;
  fixtures: unknown;
  directory: string;
  inputs?: Record<string, import("./types.js").BoundInput>;
  evaluatorOnlyPaths?: string[];
  onProgress?: (message: string) => void;
}): Promise<ScenarioEvidence> {
  const { config, spec, scenario, fixtures, directory } = options;
  fs.mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const kind = scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace");
  if (kind === "browser" && !config.target.url) {
    throw new Error(`Scenario ${scenario.id} uses browser mode but target.url is not configured`);
  }

  if (kind === "command") return collectCommand(config, scenario, directory);

  const promptFile = path.join(directory, "prompt.md");
  const outputFile = path.join(directory, "provider-final.json");
  const schemaFile = path.join(directory, "scenario-output.schema.json");
  const eventLogFile = path.join(directory, "provider-events.ndjson");
  const stderrFile = path.join(directory, "provider-stderr.log");
  fs.writeFileSync(promptFile, scenarioPrompt({ config, spec, scenario, kind, fixtures, inputs: options.inputs }));
  writeJson(schemaFile, scenarioOutputSchema);

  let mcp: ProviderInvocation["mcp"];
  let trustedStorageStatePath: string | undefined;
  let storageStateCandidatePath: string | undefined;
  const personaPromotions: Array<{ candidate: string; destination: string }> = [];
  if (kind === "browser") {
    const personaState = scenario.persona && scenario.persona !== "anonymous" ? personaAuthPath(config, scenario.persona) : undefined;
    const existingPersonaState = personaState && fs.existsSync(personaState) ? personaState : undefined;
    const chainState = scenario.persona === "anonymous" || scenario.allowedPersonas ? undefined : chainStorageStatePath(spec, scenario, directory);
    const stateDestination = existingPersonaState ?? (scenario.requiresAuth ? undefined : chainState);
    const existingState = stateDestination && fs.existsSync(stateDestination) ? stateDestination : undefined;
    if ((scenario.requiresAuth || (scenario.allowedPersonas && scenario.persona && scenario.persona !== "anonymous")) && (!existingPersonaState || !scenario.persona)) {
      const blocked: ScenarioEvidence = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        kind,
        persona: scenario.persona,
        sourceScenarioId: scenario.sourceScenarioId,
        caseId: scenario.caseId,
        strata: scenario.strata,
        split: scenario.split,
        outcome: "blocked",
        inputs: options.inputs,
        summary: `No saved browser session for required persona ${scenario.persona ?? "(unnamed)"}. Run aek auth first.`,
        observations: [],
        evidenceRefs: [],
        transcript: [],
        screenshots: [],
        artifacts: { prompt: "prompt.md" },
        provider: config.agent.provider,
        model: config.agent.model,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
      };
      writeJson(path.join(directory, "evidence.json"), blocked);
      return blocked;
    }
    if (scenario.capture) return controlledCapture(config, scenario, directory, existingPersonaState);
    // A persona path is permanent authentication state and may only be updated
    // when it was already established by `aek auth`. If an uncaptured persona
    // participates in a dependency chain, use the run-local chain state instead.
    trustedStorageStatePath = stateDestination;
    storageStateCandidatePath = trustedStorageStatePath
      ? path.join(directory, ".storage-state.candidate.json")
      : undefined;
    const personas = scenario.allowedPersonas ? Object.fromEntries(scenario.allowedPersonas.map((persona, index) => {
      if (persona === "anonymous") return [persona, {}];
      const destination = personaAuthPath(config, persona);
      const candidate = path.join(directory, `.persona-${index}.candidate.json`);
      personaPromotions.push({ candidate, destination });
      return [persona, { storageStatePath: destination, candidatePath: candidate }];
    })) : undefined;
    const context: BrowserMcpContext = {
      persona: scenario.persona,
      personas,
      outputs: scenario.outputs,
      targetUrl: config.target.url!,
      allowedOrigins: config.target.allowedOrigins,
      evidenceDir: directory,
      storageStatePath: existingState,
      storageStateCandidatePath,
      expectAuthenticated: Boolean(scenario.requiresAuth || (scenario.allowedPersonas && scenario.persona && scenario.persona !== "anonymous")),
      fixtureFiles: fixtureFiles(fixtures, config.paths.fixtures, config.project.root),
      headless: config.browser.headless,
      viewport: config.browser.viewport,
      actionTimeoutMs: config.browser.actionTimeoutMs,
      screenshotFormat: config.browser.screenshotFormat,
      // Claude and Grok enforce maxTurns in their provider CLIs. Codex has no
      // equivalent flag, so only Codex maps the option to MCP interactions.
      maxToolCalls: config.agent.provider === "codex" ? config.agent.maxTurns ?? 50 : undefined,
    };
    const contextFile = path.join(directory, "browser-context.json");
    writeJson(contextFile, context);
    const launch = browserMcpLaunch(contextFile);
    const mcpConfig = writeMcpConfig(directory, "aek", launch.command, launch.args);
    mcp = {
      name: "aek",
      command: launch.command,
      args: launch.args,
      configFile: mcpConfig,
      toolNames: BROWSER_TOOL_NAMES,
    };
  } else {
    const context: WorkspaceMcpContext = {
      outputs: scenario.outputs,
      projectRoot: config.project.root,
      evidenceDir: directory,
      maxToolCalls: config.agent.provider === "codex" ? config.agent.maxTurns ?? 50 : undefined,
      evaluatorOnlyPaths: [
        ...(options.evaluatorOnlyPaths ?? []),
        ...Object.values(fixtureFiles(fixtures, config.paths.fixtures, config.project.root)),
      ],
    };
    const contextFile = path.join(directory, "workspace-context.json");
    writeJson(contextFile, context);
    const launch = workspaceMcpLaunch(contextFile);
    const mcpConfig = writeMcpConfig(directory, "aek", launch.command, launch.args);
    mcp = {
      name: "aek",
      command: launch.command,
      args: launch.args,
      configFile: mcpConfig,
      toolNames: WORKSPACE_TOOL_NAMES,
    };
  }

  options.onProgress?.(`starting ${config.agent.provider}${config.agent.model ? `/${config.agent.model}` : ""}`);
  const stateCandidates = [...personaPromotions, ...(storageStateCandidatePath && trustedStorageStatePath
    ? [{ candidate: storageStateCandidatePath, destination: trustedStorageStatePath }] : [])];
  try {
    const providerResult = await runProvider(config.agent.provider, {
      purpose: "scenario",
      // Artifacts remain here, while real provider adapters execute from a
      // disposable directory outside target-owned instruction-file scope.
      // Project inspection goes through the path-contained, read-only MCP.
      cwd: directory,
      promptFile,
      outputFile,
      outputSchemaFile: schemaFile,
      eventLogFile,
      stderrFile,
      model: config.agent.model,
      effort: config.agent.effort,
      maxTurns: config.agent.maxTurns,
      timeoutSeconds: config.agent.timeoutSeconds,
      extraArgs: config.agent.extraArgs,
      mcp,
      additionalDirs: [],
      allowWorkspaceTools: false,
      onProgress: options.onProgress,
    });
    writeJson(path.join(directory, "provider-run.json"), {
      provider: config.agent.provider,
      command: providerResult.command,
      exitCode: providerResult.exitCode,
      signal: providerResult.signal,
      timedOut: providerResult.timedOut,
      sessionId: providerResult.sessionId,
      usage: providerResult.usage,
      policyViolations: providerResult.policyViolations,
    });

    const toolArtifacts = readToolArtifacts(directory, kind);
    const parsed = scenarioOutputValidator.safeParse(providerResult.structured);
    const policyFailed = Boolean(providerResult.policyViolations?.length);
    // Mock intentionally has no MCP process. Every real scenario provider must
    // finalize through the bounded MCP so schema-valid prose alone cannot turn
    // into evidence that scoring treats as a reached scenario.
    const missingFinalization = config.agent.provider !== "mock" && !toolArtifacts.result;
    const terminalOutcome = toolArtifacts.result?.outcome;
    const evidenceTools = kind === "browser"
      ? new Set(["navigate"])
      : new Set(["list_files", "read_file", "search"]);
    const requiresEvidenceActivity = terminalOutcome === "completed" || terminalOutcome === "feature_not_found";
    const hasEvidenceActivity = toolArtifacts.transcript.some((entry) => !entry.isError && evidenceTools.has(entry.tool));
    const missingEvidenceActivity =
      config.agent.provider !== "mock" && !missingFinalization && requiresEvidenceActivity && !hasEvidenceActivity;
    let outputs: Record<string, import("./types.js").ScenarioOutput> = {};
    let outputError: string | undefined;
    try {
      const outputsFile = path.join(directory, "outputs.json");
      outputs = validateOutputs(scenario, fs.existsSync(outputsFile) ? readJson(outputsFile) : {}, toolArtifacts.transcript);
    } catch (error) {
      outputError = `Invalid scenario outputs: ${error instanceof Error ? error.message : String(error)}`;
    }
    const invalidStructuredOutput = !parsed.success;
    const providerFailed =
      providerResult.timedOut ||
      providerResult.exitCode !== 0 ||
      policyFailed ||
      missingFinalization ||
      missingEvidenceActivity ||
      invalidStructuredOutput || Boolean(outputError);
    const outcome = providerFailed
      ? "agent_error"
      : toolArtifacts.result?.outcome ?? (parsed.success ? parsed.data.outcome : "agent_error");
    const summary = outputError ?? (
      policyFailed
        ? `Evidence-boundary violation: ${providerResult.policyViolations!.join("; ")}`
        : providerResult.timedOut
          ? `Scenario provider timed out after ${config.agent.timeoutSeconds}s.`
          : providerResult.exitCode !== 0
              ? `Scenario provider exited ${providerResult.exitCode}; see provider-stderr.log.`
              : missingFinalization
                ? `Scenario provider did not finalize evidence through the ${kind} MCP done tool.`
                : missingEvidenceActivity
                  ? `Scenario provider finalized ${terminalOutcome} without first collecting evidence through the ${kind} MCP.`
                  : invalidStructuredOutput
                    ? "Provider returned invalid structured output."
                    : toolArtifacts.result?.summary ?? parsed.data.summary);
    const error = outputError ?? (
      outcome === "agent_error"
        ? providerResult.timedOut
          ? `Provider timed out after ${config.agent.timeoutSeconds}s`
          : policyFailed
            ? `Provider used forbidden built-in tools: ${providerResult.policyViolations!.join(", ")}`
            : providerResult.exitCode !== 0
                ? `Provider exited ${providerResult.exitCode}`
                : missingFinalization
                  ? `Provider did not call the ${kind} MCP done tool`
                  : missingEvidenceActivity
                    ? `Provider did not perform a successful ${kind} evidence-gathering MCP action before finalizing ${terminalOutcome}`
                    : invalidStructuredOutput
                      ? z.prettifyError(parsed.error)
                      : undefined
        : undefined);
    const structuredTrusted = parsed.success && !providerFailed;
    const structuredObservations = structuredTrusted ? parsed.data.observations : [];
    const evidenceRefs = structuredTrusted ? parsed.data.evidenceRefs : [];

    const missingOutputs = Object.keys(scenario.outputs ?? {}).filter(name => !Object.hasOwn(outputs, name));
    const diagnostics = kind === "browser" ? readDiagnostics(directory, config.browser.diagnostics) : undefined;
    const evidence: ScenarioEvidence = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      kind,
      persona: scenario.persona,
      sourceScenarioId: scenario.sourceScenarioId,
      caseId: scenario.caseId,
      strata: scenario.strata,
      split: scenario.split,
      outcome: outcome === "completed" && missingOutputs.length ? "blocked" : outcome,
      summary: outcome === "completed" && missingOutputs.length ? `Required outputs unavailable: ${missingOutputs.join(", ")}. ${summary}` : summary,
      outputs,
      inputs: options.inputs,
      diagnostics: diagnostics?.diagnostics,
      captureChecks: diagnostics?.checks,
      observations: [...new Set([...toolArtifacts.observations, ...structuredObservations, ...(diagnostics?.diagnostics.map(entry => `Browser ${entry.kind}: ${entry.message}`) ?? [])])],
      evidenceRefs: [...new Set(evidenceRefs)],
      transcript: toolArtifacts.transcript,
      screenshots: toolArtifacts.screenshots,
      artifacts: {
        prompt: "prompt.md",
        providerEvents: "provider-events.ndjson",
        providerStderr: "provider-stderr.log",
        providerRun: "provider-run.json",
        toolTranscript: `${kind}-transcript.ndjson`,
      },
      provider: config.agent.provider,
      model: config.agent.model,
      providerSessionId: providerResult.sessionId,
      usage: providerResult.usage,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      finalUrl: "finalUrl" in (toolArtifacts.result ?? {}) ? (toolArtifacts.result as BrowserResultState).finalUrl : undefined,
      error,
    };
    writeJson(path.join(directory, "evidence.json"), evidence);
    if (!providerFailed && toolArtifacts.result?.outcome !== "blocked") {
      // Validate every candidate before updating any saved identity.
      const updates = stateCandidates.filter(({ candidate }) => fs.existsSync(candidate)).map(({ candidate, destination }) => {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Browser storage-state candidate must be a regular file");
        return { destination, value: readJson(candidate) };
      });
      for (const { destination, value } of updates) writeJson(destination, value, { mode: 0o600 });
    }
    if (providerFailed) {
      throw new Error(`${summary} See ${directory} for retained scenario diagnostics.`);
    }
    return evidence;
  } finally {
    for (const { candidate } of stateCandidates) fs.rmSync(candidate, { force: true });
  }
}
