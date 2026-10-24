#!/usr/bin/env node
import { CliOutput, JSON_RESULT_COMMANDS, runResult } from "./cli-output.js";
import { commandHelp } from "./cli-help.js";
import { specSourceBytes } from "./specs.js";
import { promoteTextReference, listTextReferences } from "./text/references.js";
import { changedTextCases } from "./text/selection.js";
import { requireDefined, omitUndefined } from "./invariants.js";
import fs from "node:fs";
import { loadSealedDefinitions, validateEvaluationInputs } from "./run/inputs.js";
import path from "node:path";
import YAML from "yaml";
import { captureAuth } from "./auth.js";
import { cancellationSignal, withCliSignals } from "./cancellation.js";
import { listPromotedBaselines, loadPromotedBaseline, promoteBaseline } from "./baselines.js";
import { loadCampaignState, runCampaign } from "./campaign-run.js";
import {
  campaignComparisonFailures,
  compareCampaigns,
  defaultCampaignComparisonOutput,
  loadCampaign,
  writeCampaignComparisonArtifacts,
} from "./campaign-compare.js";
import { evaluateCiThresholds } from "./ci.js";
import {
  compareReports,
  comparisonFailures,
  defaultComparisonOutput,
  loadComparisonInput,
  writeComparisonArtifacts,
} from "./compare.js";
import {
  findConfigFile,
  loadConfig,
  loadResolvedConfig,
  resolveConfigFile,
  type ConfigOverrides,
} from "./config.js";
import { doctor, readyProviders } from "./doctor.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { isWithin, prospectiveRealPath, sha256, stableJson } from "./io.js";
import {
  adjudicateReport,
  finalizeReport,
  recoverInterruptedReportUpdate,
  writeReportArtifactsRecoverably,
} from "./report.js";
import { buildRunReceipt, configCompatibility } from "./receipts.js";
import { PromotionPolicyError } from "./promotion.js";
import { judgeCollected } from "./judge-run.js";
import { runJudgeValidation } from "./judge-validation.js";
import { runEvaluation } from "./runner.js";
import { loadRunState, withRunLock } from "./run/state.js";
import { buildReport, scoreArea } from "./scoring.js";
import {
  assertScenarioSelectors,
  assertScenarioTargetCompatibility,
  assertEmailConfiguration,
  loadFixtures,
  loadSpecFile,
  loadSpecs,
  loadSelectedSpecs,
  materializeSpecs,
  selectSpecs,
} from "./specs.js";
import {
  ensureGitignore,
  initializeProject,
  STARTER_KINDS,
  starterProviders,
  type StarterKind,
} from "./templates.js";
import { createPublicExport, defaultPublicExportOutput, privacyLint } from "./public-export.js";
import {
  PROVIDERS,
  type EvalConfig,
  type EvalSplit,
  type ProviderId,
  type RunReport,
} from "./types.js";
import { KIT_VERSION } from "./version.js";
import { didYouMean } from "./suggest.js";
import { formatPct, formatPoints, plural } from "./format.js";
import {
  listRuns,
  resolveRunReference,
  runSatisfies,
  type RunRequirement,
} from "./run-references.js";
import { comparisonLines } from "./comparison-summary.js";
import { runCheck, selectCheckItems, type CheckResult } from "./check.js";
import { describeRuns, formatRunTable, pruneRuns, sparkline } from "./runs.js";
import { chooseSkillsDirectory, installSkills } from "./skills.js";
import { oneLine } from "./terminal.js";
import { promptManualVerdicts, recordedManualVerdicts } from "./manual-review.js";
import { shellArg } from "./cli-recovery.js";
import { criterionLines, displayPath, headline, nextSteps } from "./run-summary.js";
import { authoringCommand } from "./authoring/cli.js";
import { assertEvaluationPlatform } from "./platform.js";

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const [first = "help", ...rest] = argv;
  const command = ["--version", "-v"].includes(first) ? "version" : first;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = requireDefined(rest[index], "rest[index]");
    if (value === "-h") {
      flags.help = true;
      continue;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf("=");
    if (equal > 2) {
      flags[value.slice(2, equal)] = value.slice(equal + 1);
      continue;
    }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index++;
    } else flags[key] = true;
  }
  return { command, flags, positionals };
}

const booleanFlags = new Set([
  "require-ready",
  "json",
  "email",
  "include-images",
  "allow-incompatible",
  "dry-run",
  "fail-on-regression",
  "headed",
  "help",
  "debug",
  "include-optional",
  "public",
  "interactive",
]);

const knownCommands = [
  "init",
  "doctor",
  "validate",
  "list",
  "run",
  "check",
  "runs",
  "compare",
  "finalize",
  "rescore",
  "adjudicate",
  "verify",
  "baseline",
  "reference",
  "export",
  "privacy",
  "collect",
  "judge",
  "campaign",
  "benchmark",
  "image",
  "auth",
  "skills",
  "author",
  "improve",
];

function allowedCliFlags(args: Args): string[] {
  if (!knownCommands.includes(args.command))
    throw new Error(
      `Unknown command ${args.command}.${didYouMean(args.command, knownCommands, (value) => `\`aek ${value}\``)} Run \`aek --help\` to list commands.`,
    );
  if (args.command === "campaign" && args.positionals[0] && args.positionals[0] !== "compare") {
    throw new Error(
      `Unknown campaign subcommand ${args.positionals[0]}; expected \`compare\` or no subcommand.${didYouMean(args.positionals[0], ["compare"])}`,
    );
  }
  const configOverrides = [
    "suite",
    "config",
    "url",
    "max-turns",
    "agent",
    "judge",
    "agent-model",
    "judge-model",
    "headed",
  ];
  const runFlags = [
    ...configOverrides,
    "areas",
    "scenarios",
    "include-optional",
    "split",
    "resume",
    "dry-run",
    "fail-under-score",
    "fail-under-coverage",
  ];
  let allowed: string[] = [];
  switch (args.command) {
    case "improve": {
      const commands: Record<string, string[]> = {
        install: ["directory"],
        start: [
          "config",
          "suite",
          "goal",
          "output",
          "max-attempts",
          "max-stalls",
          "budget-seconds",
          "minimum-gain",
          "repetitions",
        ],
        attempt: ["session", "hypothesis"],
        evaluate: ["session", "guidance"],
        status: ["session"],
        stop: ["session", "reason"],
      };
      const subcommand = args.positionals[0] ?? "";
      allowed = Object.hasOwn(commands, subcommand) ? commands[subcommand]! : [];
      break;
    }
    case "benchmark":
      allowed = ["recipe", "output"];
      break;
    case "image":
      if (args.positionals[0] === "batch") {
        allowed = ["manifest", "output", "concurrency", "reuse", "resume", "dry-run", "json"];
        break;
      }
      allowed = [
        "candidate",
        "reference",
        "criterion",
        "absolute-criterion",
        "policy",
        "judge",
        "judge-model",
        "judge-effort",
        "timeout-seconds",
        "capacity-retries",
        "minimum-votes",
        "maximum-votes",
        "agreement",
        "minimum-confidence",
        "width",
        "height",
        "output",
        "dry-run",
        "json",
      ];
      break;
    case "author":
      if (!args.positionals[0]) break;
      allowed =
        args.positionals[0] === "install"
          ? ["directory"]
          : args.positionals[0] === "init"
            ? ["project", "mode", "description"]
            : ["project", "json", "require-ready"];
      break;
    case "init":
      allowed = ["kind", "agent", "judge"];
      break;
    case "check":
      allowed = ["config", "areas", "json"];
      break;
    case "runs":
      allowed =
        args.positionals[0] === "prune"
          ? ["config", "keep", "older-than", "dry-run", "json"]
          : ["config", "limit", "json"];
      break;
    case "skills":
      allowed = ["agent", "directory", "json"];
      break;
    case "validate":
    case "list":
      allowed = ["config", "suite"];
      break;
    case "doctor":
      allowed = ["config", "providers"];
      break;
    case "verify":
      allowed = ["run", "config"];
      break;
    case "privacy":
      allowed = ["path"];
      break;
    case "export":
      allowed = ["public", "run", "output", "config"];
      break;
    case "auth":
      allowed = ["config", "url", "headed", "persona", "at", "click", "email", "json"];
      break;
    case "rescore":
      allowed = ["run", "config", "fail-under-score", "fail-under-coverage"];
      break;
    case "finalize":
      allowed = [
        "run",
        "config",
        "reviewer",
        "interactive",
        "fail-under-score",
        "fail-under-coverage",
      ];
      break;
    case "adjudicate":
      allowed = ["run", "config", "input", "reviewer", "fail-under-score", "fail-under-coverage"];
      break;
    case "compare":
      allowed = [
        "baseline",
        "baseline-name",
        "candidate",
        "config",
        "output",
        "fail-on-regression",
        "max-score-drop",
        "max-coverage-drop",
        "allow-incompatible",
      ];
      break;
    case "reference":
      allowed =
        args.positionals[0] === "promote"
          ? ["run", "name", "reviewer", "config", "suite"]
          : ["config", "suite"];
      break;
    case "baseline":
      allowed =
        args.positionals[0] === "promote"
          ? ["run", "name", "reviewer", "config", "include-images", "mode", "reason"]
          : ["config"];
      break;
    case "campaign":
      allowed =
        args.positionals[0] === "compare"
          ? ["baseline", "candidate", "output", "fail-on-regression", "allow-incompatible"]
          : [...runFlags, "json", "repetitions", "output"];
      break;
    case "run":
      allowed = [...runFlags, "json", "changed-since", "text-cases"];
      break;
    case "collect":
      allowed = [...runFlags, "json"].filter(
        (flag) =>
          !["judge", "judge-model", "fail-under-score", "fail-under-coverage"].includes(flag),
      );
      break;
    case "judge":
      if (args.positionals[0] && args.positionals[0] !== "validate")
        throw new Error(
          `Unknown judge subcommand ${args.positionals[0]}; expected \`validate\` or no subcommand`,
        );
      allowed =
        args.positionals[0] === "validate"
          ? ["dataset", "labels", "configurations", "output"]
          : [
              "evidence",
              "resume",
              "config",
              "judge",
              "judge-model",
              "fail-under-score",
              "fail-under-coverage",
            ];
      break;
  }
  if (allowed.includes("config")) allowed.push("suite");
  const key =
    ["campaign", "judge", "improve"].includes(args.command) && args.positionals[0]
      ? `${args.command} ${args.positionals[0]}`
      : args.command;
  if (JSON_RESULT_COMMANDS.has(key)) allowed.push("json");
  allowed.push("help", "debug");
  return [...new Set(allowed)];
}

const subcommands: Record<string, string[]> = {
  benchmark: ["experiment"],
  image: ["compare", "batch"],
  author: ["install", "init", "status", "validate"],
  improve: ["install", "start", "attempt", "evaluate", "status", "stop"],
  baseline: ["promote", "list"],
  reference: ["promote", "list"],
  privacy: ["lint"],
  runs: ["list", "prune"],
  skills: ["install"],
};

/** "run", "baseline promote", or "campaign compare": the name `aek <name> --help` accepts. */
function commandName(args: Args): string {
  return args.positionals[0] &&
    (subcommands[args.command] ||
      (args.command === "campaign" && args.positionals[0] === "compare") ||
      (args.command === "judge" && args.positionals[0] === "validate"))
    ? `${args.command} ${args.positionals[0]}`
    : args.command;
}

function validateCliShape(args: Args): void {
  const choices = subcommands[args.command];
  const given = args.positionals[0];
  if (
    choices &&
    !choices.includes(given ?? "") &&
    !(args.flags.help === true && args.positionals.length === 0)
  )
    throw new Error(
      `${args.command} requires ${choices.join(" or ")}${given === undefined ? "." : ` (got ${given}).${didYouMean(given, choices)}`} See \`aek ${args.command} --help\`.`,
    );
  const allowed = allowedCliFlags(args);
  if (args.flags.resume && args.flags["dry-run"])
    throw new Error("--resume cannot be combined with --dry-run");
  if (
    args.command === "campaign" &&
    args.flags.resume &&
    Object.keys(args.flags).some((flag) => !["resume", "help", "json", "debug"].includes(flag))
  )
    throw new Error(
      "campaign --resume restores the original options; only --json and --debug may accompany --resume <directory>",
    );
  const unknown = Object.keys(args.flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length)
    throw new Error(
      `Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}.${unknown
        .map((flag) => didYouMean(flag, allowed, (value) => `--${value}`))
        .join("")} See \`aek ${commandName(args)} --help\` for options.`,
    );
  for (const [flag, value] of Object.entries(args.flags)) {
    if (booleanFlags.has(flag) && value !== true)
      throw new Error(`--${flag} does not take a value`);
  }
  for (const flag of [
    "fail-under-score",
    "fail-under-coverage",
    "max-score-drop",
    "max-coverage-drop",
  ])
    if (args.flags[flag] !== undefined) percentageFlag(args, flag);
  const maximumPositionals =
    args.command === "check"
      ? Number.POSITIVE_INFINITY
      : args.command === "init" ||
          [
            "image",
            "author",
            "improve",
            "baseline",
            "benchmark",
            "reference",
            "campaign",
            "privacy",
            "judge",
            "runs",
            "skills",
          ].includes(args.command)
        ? 1
        : 0;
  if (args.positionals.length > maximumPositionals) {
    throw new Error(`Unexpected positional argument: ${args.positionals[maximumPositionals]}`);
  }
}

function assertCompletedComparisonRun(file: string, role: "baseline" | "candidate"): void {
  const state = loadRunState(path.dirname(file));
  if (state.status !== "complete") {
    throw new Error(`Only complete runs can be compared; ${role} run status is ${state.status}`);
  }
}

function assertComparisonOutputLocation(output: string, inputFiles: string[]): void {
  const resolvedOutput = prospectiveRealPath(output);
  for (const file of inputFiles) {
    const runDir = fs.realpathSync(path.dirname(file));
    if (
      !fs.existsSync(path.join(runDir, "artifact-index.json")) ||
      !isWithin(runDir, resolvedOutput)
    )
      continue;
    const comparisons = prospectiveRealPath(path.join(runDir, "comparisons"));
    if (!isWithin(comparisons, resolvedOutput)) {
      throw new Error(
        `Comparison output inside a sealed run must be beneath its comparisons directory: ${path.join(runDir, "comparisons")}`,
      );
    }
  }
}

const help = `aek — Agent Eval Kit v${KIT_VERSION}

Usage: aek <command> [options]
       aek help <command>          Options for a command (same as aek <command> --help)
       aek --version

Getting started
  init [directory]                 Create a starter kit and onboarding guide
  doctor                           Check provider CLIs, logins, and browser support
  validate                         Validate configuration, specs, and referenced files
  list                             List areas, scenarios, rubric items, weights, and tags

Run and review
  run                              Execute scenarios, checkers, and judges; write reports
  check [item ...]                 Run command checkers now, without creating a run
  runs list | prune                Show run history and score trend; delete old runs
  compare                          Compare a candidate run with a baseline run
  finalize                         Record manual verdicts (--interactive prompts for each)
  rescore                          Reapply current weights and gates without model calls
  adjudicate                       Resolve automatic abstentions with audited human evidence
  verify                           Verify checksums for a retained run

Baselines and sharing
  baseline promote | list          Manage append-only promoted baseline snapshots
  reference promote | list         Promote reviewed text references
  export --public                  Create a minimal, privacy-linted shareable package
  privacy lint                     Scan files for likely private data

Advanced evaluation
  collect                          Seal evidence and executable checks without a judge
  judge                            Judge a sealed collection in a new run
  judge validate                   Compare judges against separately reviewed labels
  campaign                         Repeat an evaluation; campaign compare pairs results
  benchmark experiment             Compare candidates in counterbalanced blocks
  image compare | batch            Compare local images without a project config
  auth                             Capture a browser login session for a persona

Coding-agent workflows
  skills install                   Install the authoring and improvement skills
  author init | status | validate  Keep a requirements map for guided authoring
  improve start | attempt | evaluate | status | stop
                                   Bounded hypothesis, edit, and evaluate loop

Runs: --run, --baseline, --candidate, --resume, --evidence, and --changed-since accept
a directory, a run ID from paths.runs, latest, or previous.
Config: the nearest evalkit.yaml in this directory or a parent (up to the Git root);
--config <file> selects another. Commands accepting --config also accept --suite <name>.
Output: --json prints one structured result on stdout; progress goes to stderr.
Set NO_COLOR=1 to disable colour. Use --debug for stack traces.
Exit: 0 completed; 1 input/execution error; 2 acceptance failure (written reports are
kept); 130/143 interrupted.

Provider adapters remove API-key environment variables, so Codex, Claude Code,
Grok Build, and Cursor use their saved subscription login.
`;

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === true) throw new Error(`--${name} requires a value`);
  return typeof value === "string" ? value : undefined;
}

/** A run flag as a directory, resolving run IDs and latest/previous beneath paths.runs. */
function runFlag(args: Args, flag: string, requirement: RunRequirement): string | undefined {
  const value = stringFlag(args, flag);
  if (value === undefined) return undefined;
  return resolveRunReference(value, {
    flag,
    requirement,
    runsDir: () => configFor(args).config.paths.runs,
  });
}

function requiredRunFlag(
  args: Args,
  flag: string,
  requirement: RunRequirement,
  missing: string,
): string {
  const value = runFlag(args, flag, requirement);
  if (value === undefined) throw new Error(missing);
  return value;
}

function csv(value?: string): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveIntegerFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function nonNegativeIntegerFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value) || value < 0)
    throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function percentageFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`--${name} must be a number from 0 to 100`);
  }
  return value;
}

function providerFlag(args: Args, name: string): ProviderId | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of ${PROVIDERS.join(", ")}`);
  }
  return value as ProviderId;
}

function splitFlag(args: Args): EvalSplit | "all" {
  const value = stringFlag(args, "split") ?? "development";
  if (!["development", "evaluation", "all"].includes(value)) {
    throw new Error("--split must be development, evaluation, or all");
  }
  return value as EvalSplit | "all";
}

let announcedConfig: string | undefined;

/** The explicit --config file, else the nearest evalkit.yaml, noting once when it came from a parent. */
function projectConfigFile(args: Args): string {
  const explicit = stringFlag(args, "config");
  const file = resolveConfigFile(explicit);
  if (explicit === undefined && path.dirname(file) !== process.cwd() && announcedConfig !== file) {
    announcedConfig = file;
    cliOutput.log(`Using ${path.relative(process.cwd(), file)}`, "muted");
  }
  return file;
}

function configFor(
  args: Args,
  fallbackFile?: string,
  inheritedOverrides: ConfigOverrides = {},
  resolved = false,
): { file: string; config: EvalConfig; overrides: ConfigOverrides } {
  const explicit = stringFlag(args, "config");
  const file =
    explicit !== undefined || fallbackFile === undefined
      ? projectConfigFile(args)
      : path.resolve(fallbackFile);
  const overrides: ConfigOverrides = { ...inheritedOverrides };
  const suite = stringFlag(args, "suite");
  if (suite !== undefined) overrides.suite = suite;
  const targetUrl = stringFlag(args, "url");
  const agentProvider = providerFlag(args, "agent");
  const judgeProvider = providerFlag(args, "judge");
  const agentModel = stringFlag(args, "agent-model");
  const judgeModel = stringFlag(args, "judge-model");
  const maxTurns = positiveIntegerFlag(args, "max-turns");
  if (targetUrl !== undefined) overrides.targetUrl = targetUrl;
  if (agentProvider !== undefined) overrides.agentProvider = agentProvider;
  if (judgeProvider !== undefined) overrides.judgeProvider = judgeProvider;
  if (agentModel !== undefined) overrides.agentModel = agentModel;
  if (judgeModel !== undefined) overrides.judgeModel = judgeModel;
  if (maxTurns !== undefined) overrides.maxTurns = maxTurns;
  if (args.flags.headed) overrides.headed = true;
  return { file, config: (resolved ? loadResolvedConfig : loadConfig)(file, overrides), overrides };
}

function init(args: Args): void {
  const directory = args.positionals[0] ?? ".";
  const kind = stringFlag(args, "kind") ?? "web";
  const explicit = omitUndefined({
    agent: providerFlag(args, "agent"),
    judge: providerFlag(args, "judge"),
  });
  const offline = kind === "command" || kind === "visual";
  const providers =
    STARTER_KINDS.includes(kind as StarterKind) &&
    (kind !== "visual" || Object.keys(explicit).length)
      ? starterProviders(
          kind as StarterKind,
          offline || (explicit.agent && explicit.judge) ? [] : readyProviders(),
          explicit,
        )
      : undefined;
  if (providers && offline) delete providers.detected;
  const files = initializeProject(directory, kind, providers);
  const root = path.resolve(directory);
  cliOutput.log(`Created in ${displayPath(root)}:`);
  for (const file of files) cliOutput.log(`  ${path.relative(root, file)}`);
  const ignore = ensureGitignore(root);
  if (ignore !== "unchanged")
    cliOutput.log(`  .gitignore (${ignore === "created" ? "created" : "added"} .agent-eval/)`);
  if (providers && kind !== "command")
    cliOutput.log(
      `Providers: agent ${providers.agent}, judge ${providers.judge}${providers.detected === undefined ? "" : providers.detected.length ? ` (detected: ${providers.detected.join(", ")})` : " (none signed in; edit evalkit.yaml and run aek doctor)"}`,
      providers.detected?.length === 0 ? "warn" : undefined,
    );
  const tasks: Record<string, string> = {
    web: "Set the target URL, exact workflow steps, expected values, and test accounts/data.",
    repository: "Name the public interface, documented contract, and source paths to inspect.",
    command:
      "Implement evals/check.mjs and replace the example command criterion; `aek check CORE-01` runs it without creating a run. The generated checker deliberately fails until implemented.",
    artifact:
      "Supply the exported PNG, configure its source path, and define the required content and viewing size.",
    visual:
      "Run the fixture calibration, then configure your application's capture adapter and reviewed references.",
  };
  cliOutput.log(`Setup remaining: ${tasks[kind]}`);
  cliOutput.log(
    `Next: follow ${displayPath(path.join(root, "evals", "ONBOARDING.md"))} to customize, pilot, and calibrate this kit before promoting a baseline.`,
  );
  cliOutput.log(
    "Validation checks input contracts and referenced files; it does not establish that the checker is implemented or the evaluation detects defects.",
  );
}

function enforceRunThresholds(args: Args, report: RunReport): string[] {
  const failures = evaluateCiThresholds(
    report,
    omitUndefined({
      minimumScore: percentageFlag(args, "fail-under-score"),
      minimumCoverage: percentageFlag(args, "fail-under-coverage"),
    }),
  );
  for (const failure of failures) cliOutput.warn(`Acceptance failed: ${failure}`);
  if (failures.length) process.exitCode = 2;
  return failures;
}

/** The newest other complete run with a report, as the natural comparison baseline. */
function previousReportRun(runsDir: string, runDir: string): string | undefined {
  const runs = listRuns(runsDir).filter((entry) => runSatisfies(entry, "report"));
  const index = runs.findIndex((entry) => path.resolve(entry.directory) === path.resolve(runDir));
  return (index === -1 ? runs.at(-1) : runs[index - 1])?.directory;
}

function printHeadline(report: RunReport): void {
  const result = headline(report);
  cliOutput.log(`Result: ${result.text}`, result.tone);
}

function printRunCompletion(runDir: string, report: RunReport, runsDir: string): void {
  cliOutput.log(`Run: ${displayPath(runDir)}`);
  const steps = nextSteps(runDir, report, previousReportRun(runsDir, runDir));
  if (steps.length) cliOutput.log(`Next:\n${steps.map((step) => `  ${step}`).join("\n")}`, "info");
}

function loadRunConfig(args: Args, runDir: string) {
  const state = loadRunState(runDir);
  const explicitFile = stringFlag(args, "config");
  const suite = stringFlag(args, "suite");
  const file = path.resolve(explicitFile ?? state.configFile);
  const resolved =
    !explicitFile &&
    state.mode === "judge" &&
    state.evidenceSource !== undefined &&
    file === path.join(state.evidenceSource, "inputs", "config.resolved.yaml");
  return {
    file,
    config: (resolved ? loadResolvedConfig : loadConfig)(file, {
      ...state.configOverrides,
      ...(suite === undefined ? {} : { suite }),
    }),
    state,
  };
}

function assertFinalizeSpecsUnchanged(
  report: RunReport,
  specs: ReturnType<typeof loadSpecs>,
): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const area of report.areas) {
    const spec = byId.get(area.id);
    if (!spec) throw new Error(`Current specs do not contain prior area ${area.id}`);
    const expected = report.receipt.inputs.specs[spec.id];
    if (!expected || sha256(specSourceBytes(spec)) !== expected.sha256) {
      throw new Error(
        `Spec ${spec.id} changed since evidence was judged. Use rescore intentionally before finalizing manual results.`,
      );
    }
  }
}

function assertFinalizeConfigUnchanged(
  report: RunReport,
  config: EvalConfig,
  specs: ReturnType<typeof loadSpecs>,
  selectedSplit: EvalSplit | "all",
): void {
  const current = buildRunReceipt({
    config,
    specs,
    fixtures: undefined,
    ...(report.receipt.inputs.selection.scenarios === undefined
      ? {}
      : { scenarioIds: report.receipt.inputs.selection.scenarios }),
    split: selectedSplit,
    evidenceProvenance: report.receipt,
  });
  if (current.inputs.methodSha256 !== report.receipt.inputs.methodSha256) {
    throw new Error(
      "Resolved evaluator config changed since the report was last scored. Run rescore before finalizing manual results.",
    );
  }
}

function judgementDefinition(spec: ReturnType<typeof loadSpecFile>): unknown {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    scenarios: spec.scenarios,
    datasets: spec.datasets,
    rubric: spec.rubric.map((item) => {
      const { weight: _weight, tags: _tags, gate: _gate, ...judgement } = item;
      return {
        ...judgement,
        grader: item.grader.type === "hybrid" ? { type: "hybrid" } : item.grader,
      };
    }),
  };
}

function assertRescoreSpecsCompatible(
  runDir: string,
  report: RunReport,
  specs: ReturnType<typeof loadSpecs>,
): void {
  for (const spec of specs) {
    const receipt = report.receipt.inputs.specs[spec.id];
    if (!receipt) throw new Error(`Original receipt does not contain spec ${spec.id}`);
    const snapshot = path.join(runDir, "inputs", "specs", receipt.file);
    if (!fs.existsSync(snapshot)) throw new Error(`Original spec snapshot is missing: ${snapshot}`);
    const original = loadSpecFile(snapshot);
    if (stableJson(judgementDefinition(original)) !== stableJson(judgementDefinition(spec))) {
      throw new Error(
        `Spec ${spec.id} changed in judgement-relevant fields. Rescore permits only area/rubric weights, tags, gates, optional-area status, and hybrid shares; start a new run for criterion, grader, scenario, or evidence-definition changes.`,
      );
    }
  }
}

function assertOriginalScoringValid(snapshot: string): void {
  const parsed = YAML.parse(fs.readFileSync(snapshot, "utf8")) as {
    scoring?: Partial<EvalConfig["scoring"]>;
  };
  const partialCredit = parsed?.scoring?.partialCredit;
  const minimumCoverage = parsed?.scoring?.minimumCoverage;
  if (
    typeof partialCredit !== "number" ||
    !Number.isFinite(partialCredit) ||
    partialCredit < 0 ||
    partialCredit > 1 ||
    typeof minimumCoverage !== "number" ||
    !Number.isFinite(minimumCoverage) ||
    minimumCoverage < 0 ||
    minimumCoverage > 100
  )
    throw new Error(`Original resolved config snapshot has invalid scoring settings: ${snapshot}`);
}

function assertEvidenceConfigCompatible(
  runDir: string,
  report: RunReport,
  config: EvalConfig,
): void {
  const snapshot = path.join(runDir, "inputs", "config.resolved.yaml");
  if (!fs.existsSync(snapshot))
    throw new Error(`Original resolved config snapshot is missing: ${snapshot}`);
  assertOriginalScoringValid(snapshot);
  if (!report.receipt.inputs.configCompatibility)
    throw new Error("Saved config compatibility hashes are missing; start a new evaluation");
  if (
    stableJson(configCompatibility(config)) !==
    stableJson(report.receipt.inputs.configCompatibility)
  ) {
    throw new Error(
      "Resolved config changed outside scoring. Reusing evidence permits only scoring settings and compatible spec weighting metadata; start a new run for target, provider, browser, fixture, variable, instruction, or path changes.",
    );
  }
}

async function main(): Promise<void> {
  if (cliArgs.command === "version") {
    console.log(KIT_VERSION);
    return;
  }
  if (["help", "--help", "-h"].includes(cliArgs.command) && !cliArgs.positionals.length) {
    console.log(help);
    return;
  }
  // `aek help run` and `aek help baseline promote` are aliases for --help.
  const args: Args =
    cliArgs.command === "help"
      ? {
          command: requireDefined(cliArgs.positionals[0], "help topic"),
          positionals: cliArgs.positionals.slice(1),
          flags: { help: true },
        }
      : cliArgs;
  validateCliShape(args);
  if (args.flags.help) {
    console.log(
      commandHelp(args.command, args.positionals[0], allowedCliFlags(args), booleanFlags),
    );
    return;
  }
  if (args.command === "author") {
    await authoringCommand(args.positionals[0], args.flags);
    return;
  }
  if (args.command === "improve") {
    const { improvementCommand } = await import("./improvement/cli.js");
    await improvementCommand(args.positionals[0]!, args.flags, cliOutput);
    return;
  }
  if (args.command === "image" && args.positionals[0] === "batch") {
    const { imageBatchCommand } = await import("./visual/batch.js");
    await imageBatchCommand(args.flags);
    return;
  }
  if (args.command === "image") {
    const { imageCompareCommand } = await import("./visual/direct.js");
    await imageCompareCommand(args.flags);
    return;
  }
  if (args.command === "benchmark") {
    assertEvaluationPlatform();
    const recipeInput = stringFlag(args, "recipe");
    const outputInput = stringFlag(args, "output");
    if (!recipeInput) throw new Error("benchmark experiment requires --recipe <recipe.json>");
    if (!outputInput) throw new Error("benchmark experiment requires --output <new-directory>");
    const recipeFile = path.resolve(recipeInput);
    const output = path.resolve(outputInput);
    let recipe: unknown;
    try {
      recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read benchmark recipe ${recipeFile}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const { runBenchmarkExperiment } = await import("./benchmark-experiment.js");
    const summary = await runBenchmarkExperiment(output, recipe, {
      baseDirectory: path.dirname(recipeFile),
      ...omitUndefined({ signal: cancellationSignal() }),
      onProgress: (message) => console.error(message),
    });
    const completed = summary.visits.filter((visit) => visit.status === "complete").length;
    const failed = summary.visits.filter((visit) => visit.status === "error").length;
    cliOutput.log(
      `Experiment outcome: ${summary.outcome} (${completed} completed, ${failed} failed, ${summary.unattempted.length} unattempted visits).`,
    );
    if (summary.error) console.error(summary.error);
    cliOutput.log(`Report: ${path.join(output, "experiment.html")}`);
    cliOutput.log(`Summary: ${path.join(output, "summary.json")}`);
    if (!cancellationSignal()?.aborted)
      process.exitCode =
        summary.outcome === "compared" ? 0 : summary.outcome === "execution_error" ? 1 : 2;
    return;
  }
  if (
    args.command === "run" ||
    args.command === "auth" ||
    (args.command === "campaign" && args.positionals[0] !== "compare")
  )
    assertEvaluationPlatform();
  if (args.command === "init") {
    init(args);
    return;
  }

  if (args.command === "check") {
    const { config } = configFor(args);
    const specs = selectSpecs(loadSpecs(config.paths.specs), csv(stringFlag(args, "areas")), true);
    const selected = selectCheckItems(specs, args.positionals);
    const results: CheckResult[] = [];
    for (const { spec, item } of selected) {
      const result = await runCheck(config, spec, item);
      results.push(result);
      const name = `${spec.id}/${item.id}`;
      const seconds = `${(result.durationMs / 1000).toFixed(1)}s`;
      if (result.error) {
        cliOutput.log(`! ${name}  checker error after ${seconds}: ${result.error}`, "fail");
        if (result.stderr)
          cliOutput.log(
            result.stderr
              .split("\n")
              .slice(-15)
              .map((line) => `    ${line}`)
              .join("\n"),
            "muted",
          );
      } else {
        const pass = result.verdict === "pass";
        cliOutput.log(
          `${pass ? "✓" : "✗"} ${name}  ${result.verdict} (${seconds})  ${oneLine(result.reasoning ?? "")}`,
          pass ? "pass" : result.verdict === "partial" ? "warn" : "fail",
        );
      }
    }
    const errors = results.filter((result) => result.error).length;
    const passed = results.filter((result) => result.verdict === "pass").length;
    cliOutput.log(
      `${plural(results.length, "checker")}: ${passed} passed, ${results.length - passed - errors} did not pass, ${plural(errors, "execution error")}. Nothing was retained; use aek run for evidence and scores.`,
      errors ? "fail" : passed === results.length ? "pass" : "warn",
    );
    process.exitCode = errors ? 1 : passed === results.length ? 0 : 2;
    cliOutput.result({ checks: results });
    return;
  }

  if (args.command === "runs") {
    const { config } = configFor(args);
    const runsDir = config.paths.runs;
    if (args.positionals[0] === "prune") {
      const result = pruneRuns(
        runsDir,
        omitUndefined({
          keep: nonNegativeIntegerFlag(args, "keep"),
          olderThanDays: nonNegativeIntegerFlag(args, "older-than"),
          dryRun: Boolean(args.flags["dry-run"]),
        }),
      );
      for (const run of result.deleted)
        cliOutput.log(
          `${result.dryRun ? "would delete" : "deleted"} ${run.runId} (${formatBytes(run.bytes)})`,
          result.dryRun ? "warn" : undefined,
        );
      for (const runId of result.skippedActive)
        cliOutput.log(`skipped active run ${runId}`, "warn");
      for (const runId of result.skippedLocked)
        cliOutput.log(
          `skipped locked run ${runId}; resolve active or interrupted ownership before pruning`,
          "warn",
        );
      cliOutput.log(
        `${result.dryRun ? "Would delete" : "Deleted"} ${plural(result.deleted.length, "run")} (${formatBytes(result.bytes)}); kept ${result.kept} in ${displayPath(runsDir)}.`,
      );
      cliOutput.result(result);
      return;
    }
    const limit = positiveIntegerFlag(args, "limit") ?? 20;
    const runs = describeRuns(runsDir);
    const shown = runs.slice(-limit);
    if (!shown.length) cliOutput.log(`No runs in ${displayPath(runsDir)}. Start one with aek run.`);
    else {
      const [header, ...rows] = formatRunTable(shown);
      cliOutput.log(requireDefined(header, "runs table header"), "bold");
      rows.forEach((row, index) => {
        const run = shown[index]!;
        cliOutput.log(
          row,
          run.status === "failed" || run.status === "unreadable"
            ? "fail"
            : run.status === "running"
              ? "info"
              : run.gatesPassed === false
                ? "warn"
                : undefined,
        );
      });
      const scored = shown.filter((run) => run.scorePct !== null && !run.scoreWithheld);
      if (scored.length > 1)
        cliOutput.log(
          `Score trend: ${sparkline(scored.map((run) => run.scorePct))}  ${scored.map((run) => formatPct(run.scorePct)).join(" → ")}`,
          "muted",
        );
      if (runs.length > shown.length)
        cliOutput.log(`${runs.length - shown.length} older runs hidden; use --limit.`, "muted");
    }
    cliOutput.result({ runsDir, runs: shown, total: runs.length });
    return;
  }

  if (args.command === "skills") {
    const choice = chooseSkillsDirectory(
      omitUndefined({ agent: stringFlag(args, "agent"), directory: stringFlag(args, "directory") }),
    );
    const installed = installSkills(choice.directory);
    cliOutput.log(`Installed aek-author: ${displayPath(installed.author)}`, "pass");
    cliOutput.log(`Installed aek-improve: ${displayPath(installed.improve)}`, "pass");
    cliOutput.log(
      `Directory chosen by ${choice.reason}. Ask your coding agent to use $aek-author to build an evaluation, or $aek-improve to improve against one.`,
    );
    cliOutput.result({ directory: choice.directory, reason: choice.reason, ...installed });
    return;
  }

  if (args.command === "verify") {
    const runDir = requiredRunFlag(args, "run", "complete", "verify requires --run <run>");
    const index = assertArtifactIntegrity(runDir, { require: true })!;
    cliOutput.log(`Verified ${index.entries.length} artifacts; root ${index.rootSha256}`);
    cliOutput.result({
      runDir,
      verifiedArtifacts: index.entries.length,
      rootSha256: index.rootSha256,
    });
    return;
  }

  if (args.command === "privacy") {
    if (args.positionals[0] !== "lint") throw new Error("privacy requires `lint`");
    const target = path.resolve(
      stringFlag(args, "path") ??
        (() => {
          throw new Error("privacy lint requires --path <file-or-directory>");
        })(),
    );
    const lint = privacyLint(target);
    for (const finding of lint.findings)
      console.error(`${finding.file}:${finding.line}\t${finding.rule}\t${finding.message}`);
    cliOutput.log(
      `Privacy lint ${lint.status}: ${lint.scannedFiles} text files scanned, ${lint.skippedBinaryFiles} binary files skipped, ${lint.findings.length} finding(s).`,
    );
    if (lint.status === "failed") process.exitCode = 2;
    return;
  }

  if (args.command === "export") {
    if (!args.flags.public)
      throw new Error(
        "export currently requires --public to make the sanitization boundary explicit",
      );
    const runDir = requiredRunFlag(args, "run", "report", "export --public requires --run <run>");
    const output = stringFlag(args, "output") ?? defaultPublicExportOutput(runDir);
    const exported = createPublicExport({ runDir, output });
    cliOutput.log(`Public export: ${exported.directory}`);
    cliOutput.log(
      `Privacy lint passed: ${exported.lint.scannedFiles} text files scanned; ${exported.lint.skippedBinaryFiles} binary files skipped.`,
    );
    return;
  }

  if (args.command === "campaign" && args.positionals[0] === "compare") {
    const baselineInput =
      stringFlag(args, "baseline") ??
      (() => {
        throw new Error("campaign compare requires --baseline <campaign>");
      })();
    const candidateInput =
      stringFlag(args, "candidate") ??
      (() => {
        throw new Error("campaign compare requires --candidate <campaign>");
      })();
    const baseline = loadCampaign(baselineInput);
    const candidate = loadCampaign(candidateInput);
    const allowIncompatible = Boolean(args.flags["allow-incompatible"]);
    const comparison = compareCampaigns(baseline.report, candidate.report, { allowIncompatible });
    const output =
      stringFlag(args, "output") ??
      defaultCampaignComparisonOutput(candidate.file, baseline.report.campaignId);
    const artifacts = writeCampaignComparisonArtifacts(output, comparison);
    cliOutput.log(
      `Compared campaigns ${baseline.report.campaignId} → ${candidate.report.campaignId}: ${comparison.summary.improved} improved, ${comparison.summary.regressed} regressed; mean paired-case delta ${comparison.pairedCases.meanDelta ?? "n/a"}.`,
    );
    cliOutput.log(`Artifacts: ${artifacts.json}, ${artifacts.html}`);
    const failures = campaignComparisonFailures(comparison, {
      failOnRegression: Boolean(args.flags["fail-on-regression"]),
      requireCompatible: !allowIncompatible,
    });
    for (const failure of failures) cliOutput.warn(`Acceptance failed: ${failure}`);
    if (failures.length) process.exitCode = 2;
    cliOutput.result({ comparison, artifacts, acceptanceFailures: failures });
    return;
  }

  if (args.command === "reference") {
    const { config } = configFor(args);
    if (args.positionals[0] === "list") {
      for (const reference of listTextReferences(config))
        cliOutput.log(`${reference.name}\t${reference.snapshot}\t${reference.manifest.reviewer}`);
      return;
    }
    if (args.positionals[0] !== "promote") throw new Error("reference requires promote or list");
    const runDir = runFlag(args, "run", "report"),
      name = stringFlag(args, "name"),
      reviewer = stringFlag(args, "reviewer");
    if (!runDir || !name || !reviewer)
      throw new Error("reference promote requires --run, --name, and --reviewer");
    const result = promoteTextReference({ config, runDir, name, reviewer });
    cliOutput.log(
      `Promoted text reference ${name}: ${result.snapshot}\n${result.directory}\nKeys: ${result.keys.join(", ")}`,
    );
    return;
  }

  if (args.command === "baseline") {
    const action = args.positionals[0];
    if (action === "promote") {
      const runDir = requiredRunFlag(
        args,
        "run",
        "report",
        "baseline promote requires --run <run>",
      );
      const name =
        stringFlag(args, "name") ??
        (() => {
          throw new Error("baseline promote requires --name <name>");
        })();
      const reviewer =
        stringFlag(args, "reviewer") ??
        (() => {
          throw new Error("baseline promote requires --reviewer <name>");
        })();
      if (loadRunState(runDir).mode === "judge" && stringFlag(args, "config") === undefined) {
        throw new Error(
          "Detached-run promotion requires --config <current-project-config> to select the current promotion policy and suite.",
        );
      }
      const { config } = loadRunConfig(args, runDir);
      const promoted = promoteBaseline({
        config,
        runDir,
        name,
        reviewer,
        includeImages: Boolean(args.flags["include-images"]),
        mode: (stringFlag(args, "mode") ?? "release") as "release" | "milestone",
        ...omitUndefined({ reason: stringFlag(args, "reason") }),
      });
      cliOutput.log(
        `Promoted ${promoted.report.runId} as ${name} snapshot ${promoted.promotion.snapshotId}`,
      );
      cliOutput.log(`Snapshot: ${promoted.directory}`);
      return;
    }
    if (action === "list") {
      const { config } = configFor(args);
      const baselines = listPromotedBaselines(config);
      if (!baselines.length) cliOutput.log("No promoted baselines.");
      for (const baseline of baselines) {
        cliOutput.log(
          `${baseline.name}\t${baseline.sourceRunId}\t${baseline.promotedAt}\t${baseline.reviewer}\t${baseline.snapshotId}`,
        );
      }
      return;
    }
    throw new Error("baseline requires `promote` or `list`");
  }

  if (args.command === "compare") {
    const baselineInput = runFlag(args, "baseline", "report");
    const baselineName = stringFlag(args, "baseline-name");
    const candidateInput = runFlag(args, "candidate", "report");
    if (!candidateInput || Boolean(baselineInput) === Boolean(baselineName)) {
      throw new Error(
        "compare requires --candidate and exactly one of --baseline or --baseline-name",
      );
    }
    const candidate = loadComparisonInput(candidateInput);
    assertArtifactIntegrity(path.dirname(candidate.file), { require: true });
    assertCompletedComparisonRun(candidate.file, "candidate");
    let baseline: ReturnType<typeof loadComparisonInput>;
    if (baselineName) {
      baseline = loadPromotedBaseline(
        loadRunConfig(args, path.dirname(candidate.file)).config,
        baselineName,
      );
    } else {
      baseline = loadComparisonInput(baselineInput!);
      assertArtifactIntegrity(path.dirname(baseline.file), { require: true });
      assertCompletedComparisonRun(baseline.file, "baseline");
    }
    const allowIncompatible = Boolean(args.flags["allow-incompatible"]);
    const comparison = compareReports(baseline.report, candidate.report, { allowIncompatible });
    const output =
      stringFlag(args, "output") ?? defaultComparisonOutput(candidate.file, baseline.report.runId);
    assertComparisonOutputLocation(output, [candidate.file, baseline.file]);
    const artifacts = writeComparisonArtifacts(output, comparison, {
      baselineFile: baseline.file,
      candidateFile: candidate.file,
    });
    cliOutput.log(
      `Compared ${baseline.report.runId} → ${candidate.report.runId}: score ${formatPct(comparison.overall.scorePct.baseline)} → ${formatPct(comparison.overall.scorePct.candidate)} (${formatPoints(comparison.overall.scorePct.delta)}); coverage ${formatPct(comparison.overall.coveragePct.baseline)} → ${formatPct(comparison.overall.coveragePct.candidate)} (${formatPoints(comparison.overall.coveragePct.delta)})`,
    );
    for (const line of comparisonLines(comparison)) cliOutput.log(line.text, line.tone);
    cliOutput.log(`Report: ${displayPath(artifacts.html)}`);
    const failures = comparisonFailures(
      comparison,
      omitUndefined({
        failOnRegression: Boolean(args.flags["fail-on-regression"]),
        maxScoreDrop: percentageFlag(args, "max-score-drop"),
        maxCoverageDrop: percentageFlag(args, "max-coverage-drop"),
        requireCompatible: !allowIncompatible,
      }),
    );
    for (const failure of failures) cliOutput.warn(`Acceptance failed: ${failure}`);
    if (failures.length) process.exitCode = 2;
    cliOutput.result({ comparison, artifacts, acceptanceFailures: failures });
    return;
  }

  if (args.command === "doctor") {
    const requestedProvidersFlag = stringFlag(args, "providers");
    const requestedValues = csv(requestedProvidersFlag);
    if (requestedProvidersFlag !== undefined && !requestedValues?.length) {
      throw new Error("--providers requires at least one provider");
    }
    const requested = requestedValues?.map((value) => {
      if (!(PROVIDERS as readonly string[]).includes(value))
        throw new Error(`Unknown provider ${value}`);
      return value as ProviderId;
    });
    let configuredProviders: ProviderId[] | undefined;
    let requireBrowser = false;
    if (
      stringFlag(args, "config") !== undefined ||
      stringFlag(args, "suite") !== undefined ||
      findConfigFile() !== undefined
    ) {
      const { config } = configFor(args);
      const specs = loadSpecs(config.paths.specs);
      assertScenarioTargetCompatibility(specs, config.target);
      configuredProviders = [...new Set([config.agent.provider, config.judge.provider])];
      requireBrowser = specs.some((spec) =>
        spec.scenarios.some(
          (scenario) =>
            (scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")) ===
            "browser",
        ),
      );
    }
    const checks = doctor(
      omitUndefined({
        providers: requested ? [...new Set(requested)] : configuredProviders,
        requireBrowser,
      }),
    );
    for (const check of checks) {
      const marker = check.ok ? "✓" : check.required ? "✗" : "○";
      cliOutput.log(
        `${marker} ${check.name}${check.required ? "" : " (optional)"}: ${check.detail}`,
      );
    }
    if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
    cliOutput.result({ checks });
    return;
  }

  if (["rescore", "finalize", "adjudicate"].includes(args.command)) {
    const runDir = requiredRunFlag(args, "run", "report", `${args.command} requires --run <run>`);
    cliOutput.context = { runDir };
    await withRunLock(runDir, async () => {
      const state = loadRunState(runDir);
      if (state.status !== "complete") {
        throw new Error(
          `Only complete runs can be ${args.command === "rescore" ? "rescored" : args.command === "finalize" ? "finalized" : "adjudicated"}; run status is ${state.status}`,
        );
      }
      if (recoverInterruptedReportUpdate(runDir)) {
        cliOutput.log(`Recovered interrupted report update in ${runDir}`);
      }
      assertArtifactIntegrity(runDir, { require: true });
      const sealed = state.mode === "judge" && stringFlag(args, "config") === undefined;
      const prior = loadComparisonInput(path.join(runDir, "report.json")).report;
      const definitions = sealed ? loadSealedDefinitions(runDir, prior.receipt) : undefined;
      const config = definitions ? definitions.config : loadRunConfig(args, runDir).config;
      const requestedSuite = stringFlag(args, "suite");
      if (sealed && requestedSuite !== undefined && requestedSuite !== config.suite)
        throw new Error(
          `Suite ${requestedSuite} does not match the sealed run. Supply --config to select a project suite explicitly.`,
        );
      // Sealed config is already integrity-checked and may contain redacted secrets.
      // Compare current project config only when the caller chose to load it.
      if (!sealed) assertEvidenceConfigCompatible(runDir, prior, config);
      const sourceSpecs = definitions ? definitions.specs : loadSpecs(config.paths.specs);
      assertScenarioTargetCompatibility(sourceSpecs, config.target);
      const receiptSpecs = sourceSpecs.filter((spec) =>
        Object.hasOwn(prior.receipt.inputs.specs, spec.id),
      );
      const receiptSelection = prior.receipt.inputs.selection;
      const selectedSplit = receiptSelection.split ?? "all";
      const specs = materializeSpecs(receiptSpecs, selectedSplit);
      if (args.command === "finalize" || args.command === "adjudicate") {
        assertFinalizeSpecsUnchanged(prior, receiptSpecs);
        assertFinalizeConfigUnchanged(prior, config, receiptSpecs, selectedSplit);
        if (args.command === "adjudicate") {
          const inputFile = stringFlag(args, "input");
          const reviewer = stringFlag(args, "reviewer")?.trim();
          if (!inputFile || !reviewer)
            throw new Error("adjudicate requires --input <decisions.json> and --reviewer <name>");
          const report = adjudicateReport({
            runDir,
            report: prior,
            specs,
            config,
            inputFile,
            reviewer,
          });
          cliOutput.log(`Adjudicated ${displayPath(runDir)}`);
          printHeadline(report);
          cliOutput.result(runResult(runDir, report, enforceRunThresholds(args, report)));
          return;
        }
        let reviewer = stringFlag(args, "reviewer");
        const pendingIds = prior.areas.flatMap((area) =>
          area.pendingManual.map((id) => `${area.id}/${id}`),
        );
        if (args.flags.interactive) {
          const answered = await promptManualVerdicts({
            runDir,
            report: prior,
            specs,
            ...omitUndefined({ reviewer }),
          });
          if (!answered.recorded.length)
            throw new Error("No manual verdicts were entered; the run is unchanged");
          // Each new answer already has its reviewer; preserve earlier decisions' attribution.
          reviewer = undefined;
        } else if (pendingIds.length && !recordedManualVerdicts(runDir).length) {
          throw new Error(
            `No manual verdicts are recorded in ${displayPath(path.join(runDir, "manual-results.json"))}; pending: ${pendingIds.join(", ")}. Set each "verdict" to pass, partial, fail, or not_found, or run \`aek finalize --run ${shellArg(displayPath(runDir))} --interactive\`.`,
          );
        }
        const report = finalizeReport(
          omitUndefined({
            runDir,
            report: prior,
            specs,
            config,
            reviewer,
          }),
        );
        cliOutput.log(`Finalized ${displayPath(runDir)}`);
        printHeadline(report);
        const stillPending = report.areas.flatMap((area) =>
          area.pendingManual.map((id) => `${area.id}/${id}`),
        );
        if (stillPending.length) cliOutput.log(`Still pending: ${stillPending.join(", ")}`, "warn");
        cliOutput.result(runResult(runDir, report, enforceRunThresholds(args, report)));
        return;
      }
      assertRescoreSpecsCompatible(runDir, prior, receiptSpecs);
      const receipt = buildRunReceipt({
        config,
        specs: receiptSpecs,
        fixtures: undefined,
        ...(receiptSelection.scenarios === undefined
          ? {}
          : { scenarioIds: receiptSelection.scenarios }),
        split: selectedSplit,
        evidenceProvenance: prior.receipt,
      });
      const areas = prior.areas.map((area) => {
        const spec = specs.find((candidate) => candidate.id === area.id);
        if (!spec) throw new Error(`Current specs do not contain prior area ${area.id}`);
        return scoreArea({
          spec,
          judgements: area.items,
          evidence: area.scenarios,
          config,
          defects: area.defects,
          notes: area.notes,
          caseResults: area.caseResults,
        });
      });
      const report = buildReport({
        runId: prior.runId,
        startedAt: prior.startedAt,
        config,
        areas,
        receipt,
      });
      writeReportArtifactsRecoverably(
        runDir,
        report,
        specs,
        state.mode === "judge" ? { config, specs: receiptSpecs } : undefined,
      );
      cliOutput.log(`Rescored ${displayPath(runDir)}`);
      for (const area of report.areas)
        for (const line of criterionLines(
          area,
          specs.find((spec) => spec.id === area.id)?.rubric.map((item) => item.id) ?? [],
        ))
          cliOutput.log(`  ${line.text}`, line.tone);
      printHeadline(report);
      cliOutput.result(runResult(runDir, report, enforceRunThresholds(args, report)));
    });
    return;
  }

  if (args.command === "judge") {
    if (args.positionals[0] === "validate") {
      const required = (name: string) => {
        const value = stringFlag(args, name);
        if (!value?.trim()) throw new Error(`judge validate requires --${name} <value>`);
        return value;
      };
      const result = await runJudgeValidation({
        datasetFile: required("dataset"),
        labelsFile: required("labels"),
        configurationsFile: required("configurations"),
        output: required("output"),
        onProgress: (message) => cliOutput.log(message),
      });
      cliOutput.log(JSON.stringify(result.report.results));
      cliOutput.log(
        `Artifacts: ${path.join(result.output, "validation-results.json")}, ${path.join(result.output, "validation-results.html")}`,
      );
      if (result.report.observations.some((item) => item.status === "execution_error"))
        process.exitCode = 1;
      cliOutput.result({
        results: result.report.results,
        artifacts: {
          report: path.join(result.output, "validation-results.json"),
          html: path.join(result.output, "validation-results.html"),
        },
      });
      return;
    }
    const resumeDir = runFlag(args, "resume", "resumable-judging");
    const saved = resumeDir ? loadRunState(resumeDir) : undefined;
    if (saved && saved.mode !== "judge") throw new Error("judge --resume requires a judging run");
    const evidenceDir = runFlag(args, "evidence", "collection") ?? saved?.evidenceSource;
    if (!evidenceDir)
      throw new Error("judge requires --evidence <collection> or --resume <judging-run>");
    const sourceDir = fs.realpathSync(evidenceDir);
    // Verify before reading any definitions from the evidence bundle.
    assertArtifactIntegrity(sourceDir, { require: true });
    const explicitConfig = Boolean(
      stringFlag(args, "config") ||
        (saved && saved.configFile !== path.join(sourceDir, "inputs", "config.resolved.yaml")),
    );
    const { file, config, overrides } = configFor(
      args,
      saved?.configFile ?? path.join(sourceDir, "inputs", "config.resolved.yaml"),
      saved?.configOverrides,
      !explicitConfig,
    );
    const collectionState = loadRunState(sourceDir);
    const specs = selectSpecs(
      explicitConfig
        ? loadSpecs(config.paths.specs)
        : loadSelectedSpecs(
            path.join(sourceDir, "inputs", "specs"),
            collectionState.selectedSplit ?? "all",
          ),
      collectionState.selectedAreas,
      true,
    );
    const result = await judgeCollected({
      onRunCreated: (runDir) => {
        cliOutput.context = { runDir };
      },
      evidenceDir: sourceDir,
      config,
      configFile: file,
      specs,
      fixtures: explicitConfig ? loadFixtures(config.paths.fixtures) : {},
      explicitConfig,
      configOverrides: overrides,
      ...omitUndefined({ resumeDir }),
      onProgress: (message) => cliOutput.log(message),
    });
    printHeadline(result.report);
    printRunCompletion(result.runDir, result.report, config.paths.runs);
    cliOutput.result(
      runResult(result.runDir, result.report, enforceRunThresholds(args, result.report)),
    );
    return;
  }

  const resumeFlag = ["run", "collect"].includes(args.command)
    ? runFlag(args, "resume", args.command === "collect" ? "resumable-collection" : "resumable-run")
    : undefined;
  const resumeState = resumeFlag ? loadRunState(resumeFlag) : undefined;
  const campaignResume = args.command === "campaign" ? stringFlag(args, "resume") : undefined;
  const campaignState = campaignResume ? loadCampaignState(campaignResume) : undefined;
  const savedSelection = resumeState ?? campaignState;
  const { file, config, overrides } = configFor(
    args,
    savedSelection?.configFile,
    savedSelection?.configOverrides ? omitUndefined(savedSelection.configOverrides) : undefined,
  );
  const allSpecs = loadSpecs(config.paths.specs);
  assertScenarioTargetCompatibility(allSpecs, config.target);
  assertEmailConfiguration(allSpecs, config);
  if (args.command === "validate") {
    await validateEvaluationInputs(config, allSpecs);
    loadFixtures(config.paths.fixtures);
    const templates = allSpecs.reduce((n, spec) => n + spec.scenarios.length, 0);
    const executions = materializeSpecs(allSpecs).reduce((n, spec) => n + spec.scenarios.length, 0);
    cliOutput.result({
      configFile: file,
      configurationValid: true,
      areas: allSpecs.length,
      scenarioTemplates: templates,
      executableCases: executions,
      rubricItems: allSpecs.reduce((n, spec) => n + spec.rubric.length, 0),
      scope:
        "Input contracts and referenced files; does not establish implementation readiness or evaluation quality.",
    });
    cliOutput.log(
      `Valid: ${displayPath(file)}; ${plural(allSpecs.length, "area")}, ${plural(templates, "scenario template")}, ${plural(executions, "executable case")}, ${plural(
        allSpecs.reduce((n, spec) => n + spec.rubric.length, 0),
        "rubric item",
      )}.`,
      "pass",
    );
    return;
  }
  if (args.command === "list") {
    cliOutput.result({
      areas: allSpecs.map((spec) => ({
        id: spec.id,
        title: spec.title,
        weight: spec.weight,
        optional: spec.optional,
        scenarios: spec.scenarios.map(({ id, name, kind }) => ({ id, name, kind })),
        rubric: spec.rubric.map(({ id, criterion, weight, grader, gate, tags }) => ({
          id,
          criterion,
          weight,
          grader: grader.type,
          gate,
          tags,
        })),
      })),
    });
    for (const spec of allSpecs) {
      cliOutput.log(
        `${spec.id.padEnd(20)} w${String(spec.weight).padEnd(5)} ${spec.title}${spec.optional ? " (optional)" : ""}`,
      );
      for (const scenario of spec.scenarios)
        cliOutput.log(
          `  scenario ${scenario.id.padEnd(18)} ${scenario.kind ?? "auto"}  ${scenario.name}`,
        );
      for (const scenario of spec.scenarios) {
        for (const scenarioCase of scenario.cases ?? []) {
          cliOutput.log(
            `    case   ${scenarioCase.id.padEnd(18)} ${scenarioCase.split ?? scenario.split ?? "all"} [${scenarioCase.strata.join(", ") || "no strata"}]`,
          );
        }
      }
      for (const [dataset, cases] of Object.entries(spec.datasets ?? {}))
        for (const c of cases)
          cliOutput.log(
            `  text case ${spec.id}/${dataset}/${c.id} ${c.split ?? "all"} [${c.strata.join(", ")}]`,
          );
      for (const rubric of spec.rubric)
        cliOutput.log(
          `  rubric   ${rubric.id.padEnd(18)} w${rubric.weight} ${rubric.grader.type}${rubric.gate ? " GATE" : ""} [${rubric.tags.join(", ")}]`,
        );
    }
    return;
  }
  if (args.command === "auth") {
    const persona = stringFlag(args, "persona");
    if (!persona) throw new Error("auth requires --persona <name>");
    const saved = await captureAuth(
      omitUndefined({
        config,
        persona,
        startAt: stringFlag(args, "at"),
        clickText: stringFlag(args, "click"),
        email: Boolean(args.flags.email),
      }),
    );
    console.log(
      args.flags.json
        ? JSON.stringify({ persona, storageStatePath: saved })
        : `Saved ${persona} browser session to ${saved}`,
    );
    return;
  }
  if (args.command !== "run" && args.command !== "campaign" && args.command !== "collect")
    throw new Error(`Unknown command ${args.command}\n\n${help}`);

  const selected = selectSpecs(
    allSpecs,
    csv(stringFlag(args, "areas")) ?? savedSelection?.selectedAreas,
    Boolean(args.flags["include-optional"]),
  );
  const fixtures = loadFixtures(config.paths.fixtures);
  const selectedSplit =
    args.flags.split === undefined
      ? (savedSelection?.selectedSplit ?? splitFlag(args))
      : splitFlag(args);
  const scenarioIds = csv(stringFlag(args, "scenarios")) ?? savedSelection?.selectedScenarios;
  assertScenarioSelectors(materializeSpecs(selected, selectedSplit), scenarioIds, selectedSplit);
  if (args.command === "campaign") {
    const repetitions =
      campaignState?.plannedRepetitions ?? positiveIntegerFlag(args, "repetitions") ?? 3;
    if (repetitions < 2) throw new Error("--repetitions must be at least 2 for a campaign");
    const thresholds =
      campaignState?.thresholds ??
      omitUndefined({
        minimumScore: percentageFlag(args, "fail-under-score"),
        minimumCoverage: percentageFlag(args, "fail-under-coverage"),
      });
    const options = {
      config,
      configFile: file,
      specs: selected,
      fixtures,
      split: selectedSplit,
      configOverrides: overrides,
      ...omitUndefined({ scenarioIds }),
    };
    if (args.flags["dry-run"]) {
      await runEvaluation({
        ...options,
        dryRun: true,
        dryRunJson: Boolean(args.flags.json),
        previewRepetitions: repetitions,
      });
    } else {
      const result = await runCampaign({
        ...options,
        onProgress: cliOutput.log,
        onCampaignCreated: (campaignDir) => {
          cliOutput.context = { campaignDir };
        },
        repetitions,
        thresholds: omitUndefined(thresholds),
        ...omitUndefined({ output: stringFlag(args, "output"), resumeCampaign: campaignResume }),
      });
      cliOutput.result(result);
    }
    return;
  }

  const changedSince = runFlag(args, "changed-since", "report");
  if (changedSince && (args.flags["text-cases"] !== undefined || resumeState))
    throw new Error(
      "--changed-since cannot be combined with --text-cases or --resume; resume reuses the recorded selection",
    );
  const textCaseIds = changedSince
    ? changedTextCases(
        changedSince,
        buildRunReceipt({ config, specs: selected, fixtures, split: selectedSplit }),
      )
    : (csv(stringFlag(args, "text-cases")) ?? resumeState?.selectedTextCases);
  if (textCaseIds !== undefined && !args.flags.json)
    cliOutput.log(
      `Selected ${textCaseIds.length} text dataset cases; unselected cases reduce coverage.`,
    );
  const result = await runEvaluation({
    onProgress: cliOutput.log,
    onRunCreated: (runDir) => {
      cliOutput.context = { runDir };
    },
    ...omitUndefined({
      textCaseIds,
      config,
      configFile: file,
      specs: selected,
      ...(scenarioIds === undefined ? {} : { scenarioIds: scenarioIds }),
      split: selectedSplit,
      configOverrides: overrides,
      resumeDir: resumeFlag,
      dryRun: Boolean(args.flags["dry-run"]),
      dryRunJson: Boolean(args.flags.json),
    }),
    fixtures,
    collectOnly: args.command === "collect",
  });
  if (result.report) {
    printRunCompletion(result.runDir, result.report, config.paths.runs);
    cliOutput.result(
      runResult(result.runDir, result.report, enforceRunThresholds(args, result.report)),
    );
  } else if (args.command === "collect" && !args.flags["dry-run"]) {
    cliOutput.result({
      runId: path.basename(result.runDir),
      runDir: result.runDir,
      execution: "complete",
      mode: "collect",
      artifacts: { collection: path.join(result.runDir, "collection.json") },
    });
  }
}

const cliArgs = parseArgs(process.argv.slice(2));
const commandKey =
  [
    "campaign",
    "judge",
    "author",
    "improve",
    "image",
    "benchmark",
    "baseline",
    "reference",
    "privacy",
    "runs",
    "skills",
  ].includes(cliArgs.command) && cliArgs.positionals[0]
    ? `${cliArgs.command} ${cliArgs.positionals[0]}`
    : cliArgs.command;
const cliOutput = new CliOutput(
  commandKey,
  cliArgs.flags.json === true,
  cliArgs.flags.debug === true,
  JSON_RESULT_COMMANDS.has(commandKey) && !cliArgs.flags["dry-run"] && !cliArgs.flags.help,
);
const execute = [
  "image",
  "run",
  "check",
  "campaign",
  "benchmark",
  "collect",
  "judge",
  "improve",
  "finalize",
].includes(process.argv[2] ?? "")
  ? () => withCliSignals(main)
  : main;
execute()
  .then(() => cliOutput.finish())
  .catch((error) => {
    if (process.exitCode !== 130 && process.exitCode !== 143)
      process.exitCode = error instanceof PromotionPolicyError ? 2 : 1;
    cliOutput.finish(error instanceof Error ? error : new Error(String(error)));
  });
