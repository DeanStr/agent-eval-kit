import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeName, writeJson } from "./io.js";
import { EVIDENCE_TOOL_NAMES, evidenceMcpLaunch, writeMcpConfig } from "./mcp-config.js";
import { canonicalEvidenceRefs, caseJudgeRequests, judgePrompt } from "./prompts.js";
import { runProvider } from "./providers/index.js";
import { parseJsonText, shellInvocation, spawnCaptured } from "./providers/process.js";
import { judgementOutputSchema, judgementOutputValidator } from "./schemas.js";
import type {
  Defect,
  EvalConfig,
  EvalSpec,
  JudgedCase,
  JudgedItem,
  ProviderInvocation,
  RubricItem,
  ScenarioEvidence,
  Verdict,
} from "./types.js";

const commandOutputValidator = z.object({
  verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
  reasoning: z.string(),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("high"),
});

function commandCwd(item: RubricItem, config: EvalConfig, runDir: string): string {
  if (item.grader.type !== "command") return config.project.root;
  if (!item.grader.cwd || item.grader.cwd === "project") return config.project.root;
  if (item.grader.cwd === "run") return runDir;
  return path.resolve(config.project.root, item.grader.cwd);
}

async function runCommandGrader(options: {
  item: RubricItem;
  config: EvalConfig;
  runDir: string;
  directory: string;
}): Promise<JudgedItem> {
  const { item, config, runDir, directory } = options;
  if (item.grader.type !== "command") throw new Error("Expected command grader");
  fs.mkdirSync(directory, { recursive: true });
  const stdoutFile = path.join(directory, `${safeName(item.id)}.stdout.txt`);
  const stderrFile = path.join(directory, `${safeName(item.id)}.stderr.txt`);
  const shell = shellInvocation(item.grader.command);
  const result = await spawnCaptured({
    command: shell.command,
    args: shell.args,
    cwd: commandCwd(item, config, runDir),
    env: {
      ...process.env,
      AEK_PROJECT_ROOT: config.project.root,
      AEK_RUN_DIR: runDir,
      AEK_RUBRIC_ID: item.id,
    },
    timeoutSeconds: item.grader.timeoutSeconds ?? 300,
    stdoutFile,
    stderrFile,
  });
  const parsed = commandOutputValidator.safeParse(parseJsonText(result.stdout));
  // Process status is authoritative. In particular, a command must not be able
  // to print a passing JSON object and then hang until AEK kills it, or exit
  // unsuccessfully after emitting an optimistic intermediate result.
  if (!result.timedOut && result.exitCode === 0 && parsed.success) {
    return {
      id: item.id,
      ...parsed.data,
      evidenceRefs: parsed.data.evidenceRefs.length
        ? parsed.data.evidenceRefs
        : [`graders/${path.basename(stdoutFile)}`],
      source: "command",
    };
  }
  const byExit: Record<number, Verdict> = {
    0: "pass",
    1: "fail",
    2: "partial",
    3: "cannot_judge",
    4: "not_found",
  };
  const verdict = result.timedOut ? "cannot_judge" : byExit[result.exitCode ?? 3] ?? "cannot_judge";
  const output = result.stdout.trim() || result.stderr.trim();
  const structuredRefs = parsed.success ? parsed.data.evidenceRefs : [];
  const exitDescription = result.exitCode === null
    ? `Command terminated${result.signal ? ` by ${result.signal}` : " without an exit code"}`
    : `Command exited ${result.exitCode}`;
  return {
    id: item.id,
    verdict,
    confidence: verdict === "cannot_judge" ? "low" : "high",
    reasoning: result.timedOut
      ? `Command grader timed out after ${item.grader.timeoutSeconds ?? 300}s.`
      : parsed.success
        ? `${exitDescription}, overriding the structured ${parsed.data.verdict} verdict. ${parsed.data.reasoning}`
        : `${exitDescription}.${output ? ` ${output.slice(0, 1_000)}` : ""}`,
    evidenceRefs: structuredRefs.length
      ? structuredRefs
      : [`graders/${path.basename(stdoutFile)}`, `graders/${path.basename(stderrFile)}`],
    source: "command",
  };
}

const MAX_IMAGE_EDGE = 2_000;

function jpegSize(file: string): { width: number; height: number } | undefined {
  try {
    const buffer = fs.readFileSync(file);
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  } catch {
    // Missing and unreadable files are filtered by the caller.
  }
  return undefined;
}

interface JudgeImage {
  ref: string;
  file: string;
}

function pickImages(evidence: ScenarioEvidence[], runDir: string, maximum = 30): JudgeImage[] {
  const queues = evidence.map((scenario) =>
    scenario.screenshots
      .map((shot) => ({
        ref: `${scenario.scenarioId}/${shot.path}`,
        file: path.join(runDir, scenario.scenarioId, ...shot.path.split("/")),
      }))
      .filter((image) => {
        if (!fs.existsSync(image.file)) return false;
        const dimensions = jpegSize(image.file);
        return !dimensions || (dimensions.width <= MAX_IMAGE_EDGE && dimensions.height <= MAX_IMAGE_EDGE);
      })
      .reverse(),
  );
  const picked: JudgeImage[] = [];
  for (let round = 0; picked.length < maximum; round++) {
    let found = false;
    for (const queue of queues) {
      if (queue[round] && picked.length < maximum) {
        picked.push(queue[round]);
        found = true;
      }
    }
    if (!found) break;
  }
  return picked.reverse();
}

function stageImages(images: JudgeImage[], directory: string): {
  files: string[];
  byRef: Record<string, string>;
} {
  if (!images.length) return { files: [], byRef: {} };
  const root = path.join(directory, "attachments");
  fs.mkdirSync(root, { recursive: true });
  const byRef: Record<string, string> = {};
  const files = images.map((image, index) => {
    const extension = path.extname(image.file).toLowerCase() || ".jpg";
    const label = image.ref.endsWith(extension) ? image.ref.slice(0, -extension.length) : image.ref;
    const name = `${String(index + 1).padStart(3, "0")}-${safeName(label)}${extension}`;
    const destination = path.join(root, name);
    fs.copyFileSync(image.file, destination);
    byRef[image.ref] = name;
    return destination;
  });
  return { files, byRef };
}

async function runLlmJudge(options: {
  config: EvalConfig;
  spec: EvalSpec;
  items: RubricItem[];
  evidence: ScenarioEvidence[];
  runDir: string;
  directory: string;
  onProgress?: (message: string) => void;
}): Promise<{ items: JudgedItem[]; cases: JudgedCase[]; defects: Defect[]; notes: string }> {
  const { config, spec, items, evidence, runDir, directory } = options;
  const requestedCases = caseJudgeRequests(items, evidence);
  const unavailableCases = (reasoning: string): JudgedCase[] => requestedCases.map((request) => ({
    areaId: spec.id,
    ...request,
    verdict: "cannot_judge",
    confidence: "low",
    reasoning,
    evidenceRefs: [],
    source: "llm",
  }));
  fs.mkdirSync(directory, { recursive: true });
  const promptFile = path.join(directory, "prompt.md");
  const outputFile = path.join(directory, "provider-final.json");
  const schemaFile = path.join(directory, "judgement-output.schema.json");
  const eventLogFile = path.join(directory, "provider-events.ndjson");
  const stderrFile = path.join(directory, "provider-stderr.log");
  const attachments = stageImages(pickImages(evidence, runDir), directory);
  let mcp: ProviderInvocation["mcp"];
  if (attachments.files.length && config.judge.provider !== "codex") {
    const contextFile = path.join(directory, "evidence-context.json");
    writeJson(contextFile, {
      attachmentRoot: path.join(directory, "attachments"),
      screenshots: attachments.byRef,
      transcriptFile: path.join(directory, "evidence-transcript.ndjson"),
      maxToolCalls: attachments.files.length,
    });
    const launch = evidenceMcpLaunch(contextFile);
    const mcpConfig = writeMcpConfig(directory, "evidence", launch.command, launch.args);
    mcp = {
      name: "evidence",
      command: launch.command,
      args: launch.args,
      configFile: mcpConfig,
      toolNames: EVIDENCE_TOOL_NAMES,
    };
  }
  fs.writeFileSync(promptFile, judgePrompt({
    config,
    spec,
    items,
    evidence,
    attachments: attachments.byRef,
    screenshotAccess: attachments.files.length
      ? config.judge.provider === "codex" ? "attached" : "mcp"
      : "none",
  }));
  writeJson(schemaFile, judgementOutputSchema);
  options.onProgress?.(`judge ${config.judge.provider}${config.judge.model ? `/${config.judge.model}` : ""}`);

  const provider = await runProvider(config.judge.provider, {
    purpose: "judge",
    cwd: directory,
    promptFile,
    outputFile,
    outputSchemaFile: schemaFile,
    eventLogFile,
    stderrFile,
    model: config.judge.model,
    effort: config.judge.effort,
    maxTurns: config.judge.maxTurns,
    timeoutSeconds: config.judge.timeoutSeconds,
    extraArgs: config.judge.extraArgs,
    images: config.judge.provider === "codex" ? attachments.files : [],
    additionalDirs: [],
    mcp,
    allowWorkspaceTools: false,
    onProgress: options.onProgress,
  });
  writeJson(path.join(directory, "provider-run.json"), {
    provider: provider.provider,
    command: provider.command,
    exitCode: provider.exitCode,
    signal: provider.signal,
    timedOut: provider.timedOut,
    sessionId: provider.sessionId,
    usage: provider.usage,
    policyViolations: provider.policyViolations,
  });
  const parsed = judgementOutputValidator.safeParse(provider.structured);
  const policyFailed = Boolean(provider.policyViolations?.length);
  const duplicateIdentityError = parsed.success
    ? (() => {
        const itemIds = new Set<string>();
        const duplicateItems = new Set<string>();
        for (const item of parsed.data.items) {
          if (itemIds.has(item.id)) duplicateItems.add(item.id);
          itemIds.add(item.id);
        }
        const caseIds = new Set<string>();
        const duplicateCases = new Set<string>();
        for (const item of parsed.data.cases) {
          const identity = `${item.rubricId}\0${item.caseId}`;
          if (caseIds.has(identity)) duplicateCases.add(`${item.rubricId}/${item.caseId}`);
          caseIds.add(identity);
        }
        const problems = [
          duplicateItems.size ? `duplicate rubric item IDs (${[...duplicateItems].sort().join(", ")})` : "",
          duplicateCases.size ? `duplicate case identities (${[...duplicateCases].sort().join(", ")})` : "",
        ].filter(Boolean);
        return problems.length ? problems.join(" and ") : undefined;
      })()
    : undefined;
  if (!parsed.success || provider.timedOut || provider.exitCode !== 0 || policyFailed || duplicateIdentityError) {
    const invalidOutput = !parsed.success ? z.prettifyError(parsed.error) : "";
    const reason = policyFailed
      ? `Judge evidence-boundary violation: used forbidden built-in tools (${provider.policyViolations!.join(", ")}).`
      : provider.timedOut
        ? `Judge timed out after ${config.judge.timeoutSeconds}s.`
        : provider.exitCode !== 0
          ? `Judge exited ${provider.exitCode}; see _judge/provider-stderr.log.`
          : duplicateIdentityError
            ? `Judge returned invalid structured output: ${duplicateIdentityError}.`
          : `Judge returned invalid structured output: ${invalidOutput}`;
    return {
      items: items.map((item) => ({
        id: item.id,
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: reason,
        evidenceRefs: [],
        source: "llm",
      })),
      cases: unavailableCases(reason),
      defects: [],
      notes: reason,
    };
  }

  const requested = new Set(items.map((item) => item.id));
  const reachedAreaRefs = canonicalEvidenceRefs(evidence.filter((scenario) =>
    scenario.outcome === "completed" || scenario.outcome === "feature_not_found"
  ));
  const byId = new Map(parsed.data.items.filter((item) => requested.has(item.id)).map((item) => [item.id, item]));
  const normalized = items.map((rubric) => {
    const item = byId.get(rubric.id);
    if (!item) {
      return {
        id: rubric.id,
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: "Judge omitted this rubric item.",
        evidenceRefs: [],
        source: "llm" as const,
      };
    }
    const rubricEvidence = rubric.scenarios.length
      ? evidence.filter((scenario) => rubric.scenarios.includes(scenario.scenarioId))
      : evidence;
    const allowedRefs = canonicalEvidenceRefs(rubricEvidence);
    const evidenceRefs = [...new Set(item.evidenceRefs.filter((reference) => allowedRefs.has(reference)))];
    if (item.verdict !== "cannot_judge" && evidenceRefs.length === 0) {
      return {
        ...item,
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: `Evidence contract violation: judge supplied no evidence reference. Original reasoning: ${item.reasoning}`,
        evidenceRefs: [],
        source: "llm" as const,
      };
    }
    return { ...item, evidenceRefs, source: "llm" as const };
  });
  const returnedCases = new Map(parsed.data.cases.map((item) => [`${item.rubricId}\0${item.caseId}`, item]));
  const cases: JudgedCase[] = requestedCases.map((request) => {
    const item = returnedCases.get(`${request.rubricId}\0${request.caseId}`);
    if (!item) {
      return {
        areaId: spec.id,
        ...request,
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: "Judge omitted this case judgement.",
        evidenceRefs: [],
        source: "llm",
      };
    }
    const caseEvidence = evidence.filter((scenario) => request.scenarioIds.includes(scenario.scenarioId));
    const allowedCaseRefs = canonicalEvidenceRefs(caseEvidence);
    const evidenceRefs = [...new Set(item.evidenceRefs.filter((reference) => allowedCaseRefs.has(reference)))];
    const caseSpecificEvidence = caseEvidence.filter((scenario) => scenario.caseId);
    const evidenceThatMustReach = caseSpecificEvidence.length ? caseSpecificEvidence : caseEvidence;
    const caseWasReached = evidenceThatMustReach.some((scenario) =>
      scenario.outcome === "completed" || scenario.outcome === "feature_not_found"
    );
    if (item.verdict !== "cannot_judge" && !caseWasReached) {
      return {
        areaId: spec.id,
        ...request,
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: `Evidence contract violation: no case-specific scenario completed or established that the feature was not found. Original reasoning: ${item.reasoning}`,
        evidenceRefs: [],
        source: "llm",
      };
    }
    if (item.verdict !== "cannot_judge" && evidenceRefs.length === 0) {
      return {
        areaId: spec.id,
        ...request,
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: `Evidence contract violation: judge supplied no evidence reference. Original reasoning: ${item.reasoning}`,
        evidenceRefs: [],
        source: "llm",
      };
    }
    return { areaId: spec.id, ...request, ...item, evidenceRefs, source: "llm" };
  });
  const enforcedItems = normalized.map((item) => {
    const itemCases = cases.filter((candidate) => candidate.rubricId === item.id);
    if (item.verdict !== "pass" || !itemCases.length || itemCases.every((candidate) => candidate.verdict === "pass")) return item;
    const judgeable = itemCases.filter((candidate) => candidate.verdict !== "cannot_judge");
    const knownNegative = judgeable.filter((candidate) => candidate.verdict !== "pass");
    const verdict: Verdict = !knownNegative.length
      ? "cannot_judge"
      : judgeable.every((candidate) => candidate.verdict === "fail" || candidate.verdict === "not_found") && judgeable.length === itemCases.length
        ? "fail"
        : "partial";
    return {
      ...item,
      verdict,
      reasoning: `Aggregate full pass rejected because not every applicable case passed. ${item.reasoning}`,
    };
  });
  const defects = parsed.data.defects.flatMap((defect) => {
    const evidenceRefs = [...new Set(defect.evidenceRefs.filter((reference) => reachedAreaRefs.has(reference)))];
    return evidenceRefs.length ? [{ ...defect, evidenceRefs }] : [];
  });
  const droppedDefects = parsed.data.defects.length - defects.length;
  const notes = droppedDefects
    ? `${parsed.data.notes} Dropped ${droppedDefects} defect(s) without a valid evidence reference.`.trim()
    : parsed.data.notes;
  return { items: enforcedItems, cases, defects, notes };
}

export async function judgeArea(options: {
  config: EvalConfig;
  spec: EvalSpec;
  evidence: ScenarioEvidence[];
  runDir: string;
  areaDirectory: string;
  onProgress?: (message: string) => void;
  onCommandGraderComplete?: (item: RubricItem) => void;
}): Promise<{ items: JudgedItem[]; cases: JudgedCase[]; defects: Defect[]; notes: string }> {
  const commandItems = options.spec.rubric.filter((item) => item.grader.type === "command");
  const llmItems = options.spec.rubric.filter(
    (item) => item.grader.type === "llm" ||
      (item.grader.type === "hybrid" && item.grader.autoShare > 0),
  );
  const commandResults: JudgedItem[] = [];
  for (const item of commandItems) {
    options.onProgress?.(`command grader ${item.id}`);
    let result: JudgedItem;
    try {
      result = await runCommandGrader({
        item,
        config: options.config,
        runDir: options.runDir,
        directory: path.join(options.areaDirectory, "graders"),
      });
    } finally {
      options.onCommandGraderComplete?.(item);
    }
    commandResults.push(result);
  }
  const llm = llmItems.length
    ? await runLlmJudge({
        ...options,
        items: llmItems,
        directory: path.join(options.areaDirectory, "_judge"),
      })
    : { items: [], cases: [], defects: [], notes: "No LLM-graded rubric items." };
  const byId = new Map([...commandResults, ...llm.items].map((item) => [item.id, item]));
  return {
    items: options.spec.rubric.flatMap((item) => {
      const result = byId.get(item.id);
      return result ? [result] : [];
    }),
    cases: llm.cases,
    defects: llm.defects,
    notes: llm.notes,
  };
}
