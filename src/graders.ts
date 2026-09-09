import { requireDefined, omitUndefinedDeep } from "./invariants.js";
import { collectedCommandResultsSchema } from "./artifact-schemas.js";
import { assertGraderMethods } from "./judging/command-inputs.js";
import { judgeDirectText } from "./text/judge.js";
import {
  requiredJudgeResult,
  assertJudgementIdentities,
  constrainFullPass,
} from "./judging/contracts.js";
import { normalizeRubricJudgement } from "./judging/rubric.js";
import { judgePairwise } from "./visual/pairwise.js";
import { judgeVisualChecks } from "./visual/deterministic.js";
import { journalVote, decideVotes, rubricVoteVerdict } from "./visual/votes.js";
import { sha256, stableJson } from "./io.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeName, writeJson } from "./io.js";
import { EVIDENCE_TOOL_NAMES, evidenceMcpLaunch, writeMcpConfig } from "./mcp-config.js";
import { judgePrompt } from "./prompts.js";
import { caseJudgeRequests } from "./judging/evidence.js";
import { runProvider } from "./providers/index.js";
import { shellInvocation, spawnCaptured } from "./providers/process.js";
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

const commandOutputValidator = z
  .object({
    verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
    reasoning: z.string(),
    evidenceRefs: z.array(z.string()).default([]),
    confidence: z.enum(["high", "medium", "low"]).default("high"),
  })
  .strict();

function commandCwd(item: RubricItem, config: EvalConfig, runDir: string): string {
  if (item.grader.type !== "command") return config.project.root;
  if (!item.grader.cwd || item.grader.cwd === "project") return config.project.root;
  if (item.grader.cwd === "run") return runDir;
  return path.resolve(config.project.root, item.grader.cwd);
}

export async function runCommandGrader(options: {
  item: RubricItem;
  config: EvalConfig;
  runDir: string;
  directory: string;
}): Promise<JudgedItem> {
  const { item, config, runDir, directory } = options;
  if (item.grader.type !== "command") throw new Error("Expected command grader");
  if (item.grader.output !== "json" && item.grader.output !== "exit-code") {
    throw new Error(`Command grader ${item.id} requires output: json or exit-code`);
  }
  fs.mkdirSync(directory, { recursive: true });
  const stdoutFile = path.join(directory, `${safeName(item.id)}.stdout.txt`);
  const stderrFile = path.join(directory, `${safeName(item.id)}.stderr.txt`);
  assertGraderMethods(config, item, runDir);
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
  assertGraderMethods(config, item, runDir);
  const diagnostic = `Command grader ${item.id}; see ${stderrFile} and ${stdoutFile}`;
  if (result.timedOut)
    throw new Error(`${diagnostic}: timed out after ${item.grader.timeoutSeconds ?? 300}s`);
  if (result.exitCode === null)
    throw new Error(`${diagnostic}: terminated by ${result.signal ?? "an unknown signal"}`);
  if (item.grader.output === "json") {
    if (result.exitCode !== 0)
      throw new Error(`${diagnostic}: JSON grader exited ${result.exitCode}; expected exit 0`);
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${diagnostic}: expected an exact JSON object on stdout`);
    }
    const parsed = commandOutputValidator.safeParse(output);
    if (!parsed.success) throw new Error(`${diagnostic}: invalid structured output`);
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
  const verdict = byExit[result.exitCode];
  if (!verdict)
    throw new Error(`${diagnostic}: unexpected exit code ${result.exitCode}; expected 0 through 4`);
  const output = result.stdout.trim() || result.stderr.trim();
  return {
    id: item.id,
    verdict,
    confidence: verdict === "cannot_judge" ? "low" : "high",
    reasoning: `Command exited ${result.exitCode}.${output ? ` ${output.slice(0, 1_000)}` : ""}`,
    evidenceRefs: [`graders/${path.basename(stdoutFile)}`, `graders/${path.basename(stderrFile)}`],
    source: "command",
  };
}

const MAX_IMAGE_EDGE = 2_000;

function imageSize(file: string): { width: number; height: number } | undefined {
  try {
    const buffer = fs.readFileSync(file);
    if (
      buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString("ascii", 12, 16) === "IHDR"
    ) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // PNG compressed data can contain JPEG-like markers. Only parse JPEG
    // segments after establishing the format from its start-of-image marker.
    if (buffer.length < 2 || buffer.readUInt16BE(0) !== 0xffd8) return undefined;
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = requireDefined(buffer[offset + 1], "buffer[offset + 1]");
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
        const dimensions = imageSize(image.file);
        return (
          !dimensions || (dimensions.width <= MAX_IMAGE_EDGE && dimensions.height <= MAX_IMAGE_EDGE)
        );
      })
      .reverse(),
  );
  const picked: JudgeImage[] = [];
  for (let round = 0; picked.length < maximum; round++) {
    let found = false;
    for (const queue of queues) {
      if (queue[round] && picked.length < maximum) {
        picked.push(requireDefined(queue[round], "queue[round]"));
        found = true;
      }
    }
    if (!found) break;
  }
  return picked.reverse();
}

function stageImages(
  images: JudgeImage[],
  directory: string,
): {
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
  fs.mkdirSync(directory, { recursive: true });
  const transcriptFile = path.join(directory, "evidence-transcript.ndjson");
  // A later grader may fail after sealing an earlier ordinary judge's files.
  // A fresh judge context must establish its own image access on area retry.
  // Reused completed votes bypass this function and retain their transcripts.
  fs.rmSync(transcriptFile, { force: true });
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
      transcriptFile,
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
  fs.writeFileSync(
    promptFile,
    judgePrompt({
      config,
      spec,
      items,
      evidence,
      attachments: attachments.byRef,
      screenshotAccess: attachments.files.length
        ? config.judge.provider === "codex"
          ? "attached"
          : "mcp"
        : "none",
    }),
  );
  writeJson(schemaFile, judgementOutputSchema);
  options.onProgress?.(
    `judge ${config.judge.provider}${config.judge.model ? `/${config.judge.model}` : ""}`,
  );

  const provider = await runProvider(config.judge.provider, {
    purpose: "judge",
    cwd: directory,
    promptFile,
    outputFile,
    outputSchemaFile: schemaFile,
    eventLogFile,
    stderrFile,
    ...(config.judge.model === undefined ? {} : { model: config.judge.model }),
    ...(config.judge.effort === undefined ? {} : { effort: config.judge.effort }),
    ...(config.judge.maxTurns === undefined ? {} : { maxTurns: config.judge.maxTurns }),
    timeoutSeconds: config.judge.timeoutSeconds,
    extraArgs: config.judge.extraArgs,
    images: config.judge.provider === "codex" ? attachments.files : [],
    additionalDirs: [],
    ...(mcp === undefined ? {} : { mcp: mcp }),
    allowWorkspaceTools: false,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  writeJson(path.join(directory, "provider-run.json"), {
    requestedModel: config.judge.model ?? null,
    requestedEffort: config.judge.effort ?? null,
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
  if (!parsed.success || provider.timedOut || provider.exitCode !== 0 || policyFailed) {
    const invalidOutput = !parsed.success ? z.prettifyError(parsed.error) : "";
    const reason = policyFailed
      ? `Judge evidence-boundary violation: used forbidden built-in tools (${provider.policyViolations!.join(", ")}).`
      : provider.timedOut
        ? `Judge timed out after ${config.judge.timeoutSeconds}s.`
        : provider.exitCode !== 0
          ? `Judge exited ${provider.exitCode}; see _judge/provider-stderr.log.`
          : `Judge returned invalid structured output: ${invalidOutput}`;
    throw new Error(`${reason} See ${directory} for retained judge diagnostics.`);
  }

  return normalizeRubricJudgement({
    judgement: parsed.data,
    config,
    spec,
    items,
    evidence,
    directory,
    attachments: attachments.byRef,
  });
}

const repeatedResultSchema = judgementOutputValidator.extend({
  items: z.array(judgementOutputValidator.shape.items.element.extend({ source: z.literal("llm") })),
  cases: z.array(
    judgementOutputValidator.shape.cases.element.extend({
      areaId: z.string(),
      scenarioIds: z.array(z.string()),
      strata: z.array(z.string()),
      split: z.enum(["development", "evaluation"]).optional(),
      source: z.literal("llm"),
    }),
  ),
});

async function repeatedLlmJudge(
  options: Parameters<typeof runLlmJudge>[0] & { onVoteComplete?: () => void },
): Promise<Awaited<ReturnType<typeof runLlmJudge>>> {
  const policy = options.config.judge.voting;
  if (!policy) return runLlmJudge(options);
  const receipt = JSON.parse(fs.readFileSync(path.join(options.runDir, "receipt.json"), "utf8"));
  const images = pickImages(options.evidence, options.runDir).map((image) => ({
    ref: image.ref,
    sha256: sha256(fs.readFileSync(image.file)),
  }));
  const votes: Awaited<ReturnType<typeof runLlmJudge>>[] = [];
  const outcome = (item: { verdict: Verdict; confidence: "high" | "medium" | "low" }) =>
    item.verdict === "cannot_judge" ||
    { high: 1, medium: 0.7, low: 0.3 }[item.confidence] < policy.minimumConfidence
      ? "abstain"
      : item.verdict;
  const requests = caseJudgeRequests(options.items, options.evidence);
  const itemDecision = (id: string) =>
    decideVotes(
      votes.map((vote) =>
        outcome(
          requiredJudgeResult(
            vote.items.find((item) => item.id === id),
            `rubric item ${id} in ${options.directory}`,
          ),
        ),
      ),
      policy,
      ["pass"],
    );
  const caseDecision = (rubricId: string, caseId: string) =>
    decideVotes(
      votes.map((vote) =>
        outcome(
          requiredJudgeResult(
            vote.cases.find((item) => item.rubricId === rubricId && item.caseId === caseId),
            `case ${rubricId}/${caseId} in ${options.directory}`,
          ),
        ),
      ),
      policy,
      ["pass"],
    );
  while (votes.length < policy.maximumVotes) {
    const ordinal = votes.length + 1;
    options.onProgress?.(`rubric judge vote ${ordinal}/${policy.maximumVotes}`);
    votes.push(
      await journalVote({
        directory: path.join(
          options.directory,
          "votes",
          `vote-${String(ordinal).padStart(2, "0")}`,
        ),
        identity: {
          evaluator: receipt.evaluationFingerprint,
          evidence: sha256(stableJson(options.evidence)),
          images,
          ordinal,
          policy,
        },
        validate: (value) => {
          const result = omitUndefinedDeep(repeatedResultSchema.parse(value));
          assertJudgementIdentities(
            result,
            { items: options.items, cases: requests },
            options.directory,
          );
          return result;
        },
        ...(options.onVoteComplete === undefined ? {} : { seal: options.onVoteComplete }),
        run: (directory) => runLlmJudge({ ...options, directory }),
      }),
    );
    if (
      options.items.every((item) => itemDecision(item.id).decision !== "continue") &&
      requests.every(
        (request) => caseDecision(request.rubricId, request.caseId).decision !== "continue",
      )
    )
      break;
  }
  const verdict = rubricVoteVerdict;
  const cases: JudgedCase[] = requests.map((request) => {
    const decision = caseDecision(request.rubricId, request.caseId);
    const selected = votes.flatMap((vote) =>
      vote.cases.filter(
        (item) =>
          item.rubricId === request.rubricId &&
          item.caseId === request.caseId &&
          outcome(item) === decision.decision,
      ),
    );
    return {
      ...request,
      areaId: options.spec.id,
      source: "llm",
      verdict: verdict(decision.decision),
      confidence: decision.decision === "inconclusive" ? "low" : "high",
      reasoning: `Repeated judge: ${decision.decision}; ${decision.judgeable}/${decision.attempted} judgeable votes. ${selected.map((item) => item.reasoning).join(" ")}`,
      evidenceRefs: [...new Set(selected.flatMap((item) => item.evidenceRefs))],
    };
  });
  const items: JudgedItem[] = options.items.map((item) => {
    const decision = itemDecision(item.id);
    const selected = votes.flatMap((vote) =>
      vote.items.filter(
        (candidate) => candidate.id === item.id && outcome(candidate) === decision.decision,
      ),
    );
    let result = verdict(decision.decision);
    const itemCases = cases.filter((candidate) => candidate.rubricId === item.id);
    result = constrainFullPass(
      result,
      itemCases.map((candidate) => candidate.verdict),
    );
    return {
      id: item.id,
      source: "llm",
      verdict: result,
      confidence: result === "cannot_judge" ? "low" : "high",
      reasoning: `Repeated judge: ${decision.decision}; ${decision.judgeable}/${decision.attempted} judgeable votes. ${selected.map((item) => item.reasoning).join(" ")}`,
      evidenceRefs: [...new Set(selected.flatMap((item) => item.evidenceRefs))],
      votes: decision,
    };
  });
  writeJson(path.join(options.directory, "vote-summary.json"), { items, cases });
  return {
    items,
    cases,
    defects: votes.flatMap((vote) => vote.defects),
    notes: `${votes.length} fresh judge contexts evaluated fixed evidence; vote fractions are not calibrated probabilities.`,
  };
}

export async function judgeArea(options: {
  config: EvalConfig;
  spec: EvalSpec;
  evidence: ScenarioEvidence[];
  runDir: string;
  areaDirectory: string;
  onProgress?: (message: string) => void;
  onVoteComplete?: () => void;
  onCommandGraderComplete?: (item: RubricItem) => void;
  /** Execution is explicit; malformed collected results must never run project commands. */
  commands: { mode: "execute" } | { mode: "collected"; results: unknown };
}): Promise<{ items: JudgedItem[]; cases: JudgedCase[]; defects: Defect[]; notes: string }> {
  const commandItems = options.spec.rubric.filter((item) => item.grader.type === "command");
  const llmItems = options.spec.rubric.filter(
    (item) =>
      item.grader.type === "llm" || (item.grader.type === "hybrid" && item.grader.autoShare > 0),
  );
  if (!options.commands || !["execute", "collected"].includes(options.commands.mode))
    throw new Error("Command mode must be execute or collected");
  let collected: JudgedItem[] | undefined;
  if (options.commands.mode === "collected") {
    const parsed = collectedCommandResultsSchema.safeParse(options.commands.results);
    if (!parsed.success)
      throw new Error(
        `Invalid collected command results: ${parsed.error.message}; collect fresh evidence`,
      );
    collected = parsed.data;
    if (
      collected.length !== commandItems.length ||
      collected.some((result) => !commandItems.some((item) => item.id === result.id))
    )
      throw new Error(
        "Collected command IDs must exactly match the rubric; collect fresh evidence",
      );
  }
  const commandResults: JudgedItem[] = [];
  for (const item of commandItems) {
    if (collected) {
      const matches = collected.filter((result) => result.id === item.id);
      if (matches.length !== 1)
        throw new Error(
          `Missing or duplicate collected command result: ${item.id}; collect fresh evidence`,
        );
      commandResults.push(requireDefined(matches[0], `collected command result ${item.id}`));
      continue;
    }
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
  const visualChecks = await judgeVisualChecks(options);
  const llm = llmItems.length
    ? await repeatedLlmJudge({
        ...options,
        items: llmItems,
        directory: path.join(options.areaDirectory, "_judge"),
      })
    : { items: [], cases: [], defects: [], notes: "No LLM-graded rubric items." };
  const pairwise = await judgePairwise(options);
  const textPairwise = await judgeDirectText(options);
  const captureResults: JudgedItem[] = options.spec.rubric
    .filter((item) => item.grader.type === "capture")
    .map((item) => {
      const evidence = item.scenarios.map((id) =>
        options.evidence.find((scenario) => scenario.scenarioId === id),
      );
      const checks = evidence.flatMap((scenario) => scenario?.captureChecks ?? []);
      const unavailable = evidence.some(
        (scenario) => scenario?.outcome !== "completed" || !scenario.captureChecks?.length,
      );
      return {
        id: item.id,
        source: "capture",
        verdict: unavailable
          ? "cannot_judge"
          : checks.every((check) => check.pass)
            ? "pass"
            : "fail",
        confidence: unavailable ? "low" : "high",
        reasoning: `${checks.length} instrumented/browser checks; ${checks.filter((check) => !check.pass).length} failed.${unavailable ? " Some scenarios or checks were unavailable." : ""}`,
        evidenceRefs: evidence.flatMap((scenario) =>
          scenario ? [`${scenario.scenarioId}/evidence.json`] : [],
        ),
      };
    });
  const byId = new Map(
    [
      ...commandResults,
      ...captureResults,
      ...visualChecks,
      ...llm.items,
      ...pairwise.items,
      ...textPairwise.items,
    ].map((item) => [item.id, item]),
  );
  return {
    items: options.spec.rubric.flatMap((item) => {
      const result = byId.get(item.id);
      return result ? [result] : [];
    }),
    cases: [...llm.cases, ...pairwise.cases, ...textPairwise.cases],
    defects: [...llm.defects, ...pairwise.defects],
    notes: llm.notes,
  };
}
