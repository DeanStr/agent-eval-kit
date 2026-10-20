#!/usr/bin/env node
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
import { cancellationSignal, CliInterruptionError, withCliSignals } from "./cancellation.js";
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
import { loadConfig, loadResolvedConfig, type ConfigOverrides } from "./config.js";
import { doctor } from "./doctor.js";
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
import { initializeProject } from "./templates.js";
import { createPublicExport, defaultPublicExportOutput, privacyLint } from "./public-export.js";
import {
  PROVIDERS,
  type EvalConfig,
  type EvalSplit,
  type ProviderId,
  type RunReport,
} from "./types.js";
import { KIT_VERSION } from "./version.js";
import { authoringCommand } from "./authoring/cli.js";
import { assertEvaluationPlatform } from "./platform.js";

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = requireDefined(rest[index], "rest[index]");
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
  "include-optional",
  "public",
]);

function allowedCliFlags(args: Args): string[] {
  const knownCommands = new Set([
    "image",
    "author",
    "adjudicate",
    "auth",
    "baseline",
    "benchmark",
    "reference",
    "campaign",
    "compare",
    "doctor",
    "export",
    "finalize",
    "init",
    "list",
    "privacy",
    "rescore",
    "run",
    "collect",
    "judge",
    "validate",
    "verify",
  ]);
  if (!knownCommands.has(args.command))
    throw new Error(`Unknown command ${args.command}\n\n${help}`);
  if (args.command === "campaign" && args.positionals[0] && args.positionals[0] !== "compare") {
    throw new Error(
      `Unknown campaign subcommand ${args.positionals[0]}; expected \`compare\` or no subcommand`,
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
    case "benchmark":
      allowed = ["recipe", "output"];
      break;
    case "image":
      if (
        args.positionals[0] !== "compare" &&
        !(args.flags.help === true && !args.positionals.length)
      )
        throw new Error("image requires compare");
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
      if (!args.positionals[0] && args.flags.help === true) {
        allowed = [];
        break;
      }
      if (!["install", "init", "status", "validate"].includes(args.positionals[0] ?? ""))
        throw new Error("author requires install, init, status, or validate");
      allowed =
        args.positionals[0] === "install"
          ? ["directory"]
          : args.positionals[0] === "init"
            ? ["project", "mode", "description"]
            : ["project", "json", "require-ready"];
      break;
    case "init":
      allowed = ["kind"];
      break;
    case "validate":
    case "list":
      allowed = ["config", "suite"];
      break;
    case "doctor":
      allowed = ["config", "providers"];
      break;
    case "verify":
      allowed = ["run"];
      break;
    case "privacy":
      allowed = ["path"];
      break;
    case "export":
      allowed = ["public", "run", "output"];
      break;
    case "auth":
      allowed = ["config", "url", "headed", "persona", "at", "click", "email", "json"];
      break;
    case "rescore":
      allowed = ["run", "config", "fail-under-score", "fail-under-coverage"];
      break;
    case "finalize":
      allowed = ["run", "config", "reviewer", "fail-under-score", "fail-under-coverage"];
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
  allowed.push("help");
  return [...new Set(allowed)];
}

function validateCliShape(args: Args): void {
  const allowed = allowedCliFlags(args);
  const subcommands: Record<string, string[]> = {
    benchmark: ["experiment"],
    image: ["compare"],
    author: ["install", "init", "status", "validate"],
    baseline: ["promote", "list"],
    reference: ["promote", "list"],
    privacy: ["lint"],
  };
  const choices = subcommands[args.command];
  if (
    choices &&
    !choices.includes(args.positionals[0] ?? "") &&
    !(args.flags.help === true && args.positionals.length === 0)
  )
    throw new Error(`${args.command} requires ${choices.join(" or ")}`);
  if (
    ["run", "collect", "campaign"].includes(args.command) &&
    args.flags.json &&
    (!args.flags["dry-run"] || args.flags.resume)
  )
    throw new Error(`${args.command} --json requires --dry-run and cannot resume`);
  if (args.flags.resume && args.flags["dry-run"])
    throw new Error("--resume cannot be combined with --dry-run");
  if (
    args.command === "campaign" &&
    args.flags.resume &&
    Object.keys(args.flags).some((flag) => !["resume", "help"].includes(flag))
  )
    throw new Error(
      "campaign --resume restores the original options; supply only --resume <directory>",
    );
  const unknown = Object.keys(args.flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length)
    throw new Error(
      `Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}`,
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
    args.command === "init" ||
    [
      "image",
      "author",
      "baseline",
      "benchmark",
      "reference",
      "campaign",
      "privacy",
      "judge",
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

Usage: aek <command> [flags]

  image compare --candidate file --reference file --criterion text
      [--policy preference|non_regression] [--absolute-criterion text]
      [--judge codex|claude|grok|cursor|mock] [--judge-model id] [--judge-effort value]
      [--minimum-votes n] [--maximum-votes n] [--agreement fraction]
      [--minimum-confidence fraction] [--timeout-seconds n]
      [--width pixels] [--height pixels] [--output new-directory]
      [--dry-run [--json]]          Compare two local images without a project config
  author install [--directory .agents/skills]
                                   Install the project evaluation authoring skill
  author init [--project directory] [--mode project|feature] [--description text]
                                   Create a persistent requirements and decision map
  author status [--project directory] [--json] [--require-ready]
  author validate [--project directory] [--json] [--require-ready]
                                   Validate the map, check rubric links and recorded trials
  init [directory] [--kind web|repository|command|artifact]
                                   Create a starter kit and onboarding guide
  validate [--config file]         Validate configuration, specs, and fixture paths
  list [--config file]             List areas, scenarios, graders, weights, and tags
  doctor [--config file] [--providers a,b]
                                    Check required CLIs, login, and browser support
  run [--config file]              Execute scenarios, graders, and reports
      [--url https://target] [--max-turns n (provider turns / Codex MCP calls)]
      [--areas a,b] [--scenarios x,y] [--include-optional]
      [--split development|evaluation|all] [--suite name]
      [--changed-since prior-run | --text-cases area/dataset/case,...]
      [--agent codex|claude|grok|cursor] [--judge codex|claude|grok|cursor]
      [--agent-model id] [--judge-model id] [--headed] [--dry-run [--json]]
      [--resume run-directory] [--fail-under-score pct]
      [--fail-under-coverage pct]
  campaign [--repetitions n]       Run the same evaluation repeatedly, sequentially
      [--config file] [--suite name] [--areas a,b] [--scenarios x,y]
      [--include-optional] [--split development|evaluation|all]
      [--url url] [--max-turns n] [--agent provider] [--judge provider]
      [--agent-model id] [--judge-model id] [--headed]
      [--fail-under-score pct] [--fail-under-coverage pct]
      [--dry-run [--json]] [--output directory]
  campaign --resume directory      Continue unstarted repetitions with original options
  campaign compare --baseline campaign --candidate campaign
      [--output directory] [--fail-on-regression] [--allow-incompatible]
  benchmark experiment --recipe recipe.json --output new-directory
                                   Compare candidates in explicit blocks under a shared resource lock
  reference promote --run directory --name name --reviewer name [--config file] [--suite name]
  reference list [--config file] [--suite name]
  verify --run directory           Verify checksums for retained run artifacts
  export --public --run directory  Create a minimal, privacy-linted shareable package
      [--output directory]
  privacy lint --path target       Scan a file or directory for likely private data
  auth --persona name              Capture a browser login session
       --email                     Use the persona's declared email-login flow
      [--at /login] [--click "Demo login"] [--json]
  collect                         Seal evidence and executable checks without a judge
      [--config file] [--suite name] [--areas a,b] [--scenarios x,y]
      [--include-optional] [--split development|evaluation|all]
      [--url url] [--max-turns n] [--agent provider] [--agent-model id]
      [--headed] [--dry-run [--json]] [--resume collection-directory]
  judge --evidence directory       Judge a sealed collection in a new run
        [--config file] [--judge provider] [--judge-model id]
        [--resume judging-run] [--fail-under-score pct] [--fail-under-coverage pct]
  judge validate --dataset cases.json --labels labels.json
        --configurations configurations.json --output new-directory
                                  Compare judges against reviewed evidence; write JSON and HTML
  rescore --run directory          Reapply current scoring/specs without an agent call
  finalize --run directory         Merge manual results and append review provenance
      [--reviewer name]
  adjudicate --run directory --input decisions.json --reviewer name
                                  Resolve automatic abstentions with audited human evidence
  baseline promote --run dir --name name --reviewer name [--include-images]
      [--mode release|milestone] [--reason text]
  baseline list [--config file]    Manage append-only promoted baseline snapshots
  compare --baseline run --candidate run
                                    Write JSON and HTML baseline comparison
      [--baseline-name name] [--config file]
      [--output directory] [--fail-on-regression]
      [--max-score-drop points] [--max-coverage-drop points]
      [--allow-incompatible]

Commands accepting --config also accept --suite <name>.
The --fail-under-* gates also work with rescore and finalize. Rubric items with
gate: true are always enforced. A failed CI gate uses exit code 2 while still
preserving all generated artifacts. Compare requires compatible receipts unless
--allow-incompatible is explicit.

Provider adapters remove API-key environment variables before invocation, so
Codex, Claude Code, Grok Build, and Cursor use their saved subscription login.
`;

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === true) throw new Error(`--${name} requires a value`);
  return typeof value === "string" ? value : undefined;
}

function csv(value?: string): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveIntegerFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function percentageFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`--${name} must be a number from 0 to 100`);
  }
  return value;
}

function providerFlag(args: Args, name: string): ProviderId | undefined {
  const value = stringFlag(args, name);
  if (!value) return undefined;
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

function configFor(
  args: Args,
  fallbackFile = "evalkit.yaml",
  inheritedOverrides: ConfigOverrides = {},
  resolved = false,
): { file: string; config: EvalConfig; overrides: ConfigOverrides } {
  const file = path.resolve(stringFlag(args, "config") ?? fallbackFile);
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

function init(directory: string, kind: string = "web"): void {
  const files = initializeProject(directory, kind);
  console.log(`Created ${files.map((file) => path.relative(process.cwd(), file)).join(", ")}`);
  console.log(
    `Next: follow ${path.join(directory, "evals", "ONBOARDING.md")} to customize, pilot, and calibrate this kit before promoting a baseline.`,
  );
}

function enforceRunThresholds(args: Args, report: RunReport): void {
  const failures = evaluateCiThresholds(
    report,
    omitUndefined({
      minimumScore: percentageFlag(args, "fail-under-score"),
      minimumCoverage: percentageFlag(args, "fail-under-coverage"),
    }),
  );
  for (const failure of failures) console.error(`CI threshold failed: ${failure}`);
  if (failures.length) process.exitCode = 2;
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
  const args = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(help);
    return;
  }
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
    console.log(
      `Experiment outcome: ${summary.outcome} (${completed} completed, ${failed} failed, ${summary.unattempted.length} unattempted visits).`,
    );
    if (summary.error) console.error(summary.error);
    console.log(`Report: ${path.join(output, "experiment.html")}`);
    console.log(`Summary: ${path.join(output, "summary.json")}`);
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
    init(args.positionals[0] ?? ".", stringFlag(args, "kind"));
    return;
  }

  if (args.command === "verify") {
    const runDir = path.resolve(
      stringFlag(args, "run") ??
        (() => {
          throw new Error("verify requires --run <directory>");
        })(),
    );
    const index = assertArtifactIntegrity(runDir, { require: true })!;
    console.log(`Verified ${index.entries.length} artifacts; root ${index.rootSha256}`);
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
    console.log(
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
    const runDir = path.resolve(
      stringFlag(args, "run") ??
        (() => {
          throw new Error("export --public requires --run <directory>");
        })(),
    );
    const output = stringFlag(args, "output") ?? defaultPublicExportOutput(runDir);
    const exported = createPublicExport({ runDir, output });
    console.log(`Public export: ${exported.directory}`);
    console.log(
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
    console.log(
      `Compared campaigns ${baseline.report.campaignId} → ${candidate.report.campaignId}: ${comparison.summary.improved} improved, ${comparison.summary.regressed} regressed; mean paired-case delta ${comparison.pairedCases.meanDelta ?? "n/a"}.`,
    );
    console.log(`Artifacts: ${artifacts.json}, ${artifacts.html}`);
    const failures = campaignComparisonFailures(comparison, {
      failOnRegression: Boolean(args.flags["fail-on-regression"]),
      requireCompatible: !allowIncompatible,
    });
    for (const failure of failures) console.error(`CI campaign comparison failed: ${failure}`);
    if (failures.length) process.exitCode = 2;
    return;
  }

  if (args.command === "reference") {
    const { config } = configFor(args);
    if (args.positionals[0] === "list") {
      for (const reference of listTextReferences(config))
        console.log(`${reference.name}\t${reference.snapshot}\t${reference.manifest.reviewer}`);
      return;
    }
    if (args.positionals[0] !== "promote") throw new Error("reference requires promote or list");
    const runDir = stringFlag(args, "run"),
      name = stringFlag(args, "name"),
      reviewer = stringFlag(args, "reviewer");
    if (!runDir || !name || !reviewer)
      throw new Error("reference promote requires --run, --name, and --reviewer");
    const result = promoteTextReference({ config, runDir, name, reviewer });
    console.log(
      `Promoted text reference ${name}: ${result.snapshot}\n${result.directory}\nKeys: ${result.keys.join(", ")}`,
    );
    return;
  }

  if (args.command === "baseline") {
    const action = args.positionals[0];
    if (action === "promote") {
      const runDir = path.resolve(
        stringFlag(args, "run") ??
          (() => {
            throw new Error("baseline promote requires --run <directory>");
          })(),
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
      console.log(
        `Promoted ${promoted.report.runId} as ${name} snapshot ${promoted.promotion.snapshotId}`,
      );
      console.log(`Snapshot: ${promoted.directory}`);
      return;
    }
    if (action === "list") {
      const { config } = configFor(args);
      const baselines = listPromotedBaselines(config);
      if (!baselines.length) console.log("No promoted baselines.");
      for (const baseline of baselines) {
        console.log(
          `${baseline.name}\t${baseline.sourceRunId}\t${baseline.promotedAt}\t${baseline.reviewer}\t${baseline.snapshotId}`,
        );
      }
      return;
    }
    throw new Error("baseline requires `promote` or `list`");
  }

  if (args.command === "compare") {
    const baselineInput = stringFlag(args, "baseline");
    const baselineName = stringFlag(args, "baseline-name");
    const candidateInput = stringFlag(args, "candidate");
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
    console.log(
      `Compared ${baseline.report.runId} → ${candidate.report.runId}: score ${comparison.overall.scorePct.delta === null ? "n/a" : `${comparison.overall.scorePct.delta >= 0 ? "+" : ""}${comparison.overall.scorePct.delta}`} points; coverage ${comparison.overall.coveragePct.delta === null ? "n/a" : `${comparison.overall.coveragePct.delta >= 0 ? "+" : ""}${comparison.overall.coveragePct.delta}`} points`,
    );
    console.log(`Artifacts: ${artifacts.json}, ${artifacts.html}`);
    const failures = comparisonFailures(
      comparison,
      omitUndefined({
        failOnRegression: Boolean(args.flags["fail-on-regression"]),
        maxScoreDrop: percentageFlag(args, "max-score-drop"),
        maxCoverageDrop: percentageFlag(args, "max-coverage-drop"),
        requireCompatible: !allowIncompatible,
      }),
    );
    for (const failure of failures) console.error(`CI comparison failed: ${failure}`);
    if (failures.length) process.exitCode = 2;
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
    const configFile = path.resolve(stringFlag(args, "config") ?? "evalkit.yaml");
    let configuredProviders: ProviderId[] | undefined;
    let requireBrowser = false;
    if (
      stringFlag(args, "config") !== undefined ||
      stringFlag(args, "suite") !== undefined ||
      fs.existsSync(configFile)
    ) {
      const { config } = configFor(args, configFile);
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
      console.log(`${marker} ${check.name}${check.required ? "" : " (optional)"}: ${check.detail}`);
    }
    if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
    return;
  }

  if (["rescore", "finalize", "adjudicate"].includes(args.command)) {
    const runDir = path.resolve(
      stringFlag(args, "run") ??
        (() => {
          throw new Error(`${args.command} requires --run`);
        })(),
    );
    await withRunLock(runDir, async () => {
      const state = loadRunState(runDir);
      if (state.status !== "complete") {
        throw new Error(
          `Only complete runs can be ${args.command === "rescore" ? "rescored" : args.command === "finalize" ? "finalized" : "adjudicated"}; run status is ${state.status}`,
        );
      }
      if (recoverInterruptedReportUpdate(runDir)) {
        console.log(`Recovered interrupted report update in ${runDir}`);
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
          console.log(
            `Adjudicated: ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage; ${report.manualPending} pending manual`,
          );
          enforceRunThresholds(args, report);
          return;
        }
        const report = finalizeReport(
          omitUndefined({
            runDir,
            report: prior,
            specs,
            config,
            reviewer: stringFlag(args, "reviewer"),
          }),
        );
        console.log(
          `Finalized: ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage; ${report.manualPending} pending`,
        );
        enforceRunThresholds(args, report);
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
      console.log(
        `Rescored: ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage`,
      );
      enforceRunThresholds(args, report);
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
        onProgress: (message) => console.log(message),
      });
      console.log(JSON.stringify(result.report.results));
      console.log(
        `Artifacts: ${path.join(result.output, "validation-results.json")}, ${path.join(result.output, "validation-results.html")}`,
      );
      if (result.report.observations.some((item) => item.status === "execution_error"))
        process.exitCode = 1;
      return;
    }
    const resumeDir = stringFlag(args, "resume");
    const saved = resumeDir ? loadRunState(path.resolve(resumeDir)) : undefined;
    if (saved && saved.mode !== "judge") throw new Error("judge --resume requires a judging run");
    const evidenceDir = stringFlag(args, "evidence") ?? saved?.evidenceSource;
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
      evidenceDir: sourceDir,
      config,
      configFile: file,
      specs,
      fixtures: explicitConfig ? loadFixtures(config.paths.fixtures) : {},
      explicitConfig,
      configOverrides: overrides,
      ...omitUndefined({ resumeDir }),
      onProgress: (message) => console.log(message),
    });
    console.log(`Artifacts: ${result.runDir}`);
    enforceRunThresholds(args, result.report);
    return;
  }

  const resumeFlag = ["run", "collect"].includes(args.command)
    ? stringFlag(args, "resume")
    : undefined;
  const resumeState = resumeFlag ? loadRunState(path.resolve(resumeFlag)) : undefined;
  const campaignResume = args.command === "campaign" ? stringFlag(args, "resume") : undefined;
  const campaignState = campaignResume ? loadCampaignState(campaignResume) : undefined;
  const savedSelection = resumeState ?? campaignState;
  const { file, config, overrides } = configFor(
    args,
    savedSelection?.configFile ?? "evalkit.yaml",
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
    console.log(
      `Valid: ${file}; ${allSpecs.length} areas, ${templates} scenario templates, ${executions} executable cases, ${allSpecs.reduce((n, spec) => n + spec.rubric.length, 0)} rubric items.`,
    );
    return;
  }
  if (args.command === "list") {
    for (const spec of allSpecs) {
      console.log(
        `${spec.id.padEnd(20)} w${String(spec.weight).padEnd(5)} ${spec.title}${spec.optional ? " (optional)" : ""}`,
      );
      for (const scenario of spec.scenarios)
        console.log(
          `  scenario ${scenario.id.padEnd(18)} ${scenario.kind ?? "auto"}  ${scenario.name}`,
        );
      for (const scenario of spec.scenarios) {
        for (const scenarioCase of scenario.cases ?? []) {
          console.log(
            `    case   ${scenarioCase.id.padEnd(18)} ${scenarioCase.split ?? scenario.split ?? "all"} [${scenarioCase.strata.join(", ") || "no strata"}]`,
          );
        }
      }
      for (const [dataset, cases] of Object.entries(spec.datasets ?? {}))
        for (const c of cases)
          console.log(
            `  text case ${spec.id}/${dataset}/${c.id} ${c.split ?? "all"} [${c.strata.join(", ")}]`,
          );
      for (const rubric of spec.rubric)
        console.log(
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
      await runCampaign({
        ...options,
        repetitions,
        thresholds: omitUndefined(thresholds),
        ...omitUndefined({ output: stringFlag(args, "output"), resumeCampaign: campaignResume }),
      });
    }
    return;
  }

  const changedSince = stringFlag(args, "changed-since");
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
    console.log(
      `Selected ${textCaseIds.length} text dataset cases; unselected cases reduce coverage.`,
    );
  const result = await runEvaluation({
    ...omitUndefined({
      textCaseIds,
      config,
      configFile: file,
      specs: selected,
      ...(scenarioIds === undefined ? {} : { scenarioIds: scenarioIds }),
      split: selectedSplit,
      configOverrides: overrides,
      resumeDir: stringFlag(args, "resume"),
      dryRun: Boolean(args.flags["dry-run"]),
      dryRunJson: Boolean(args.flags.json),
    }),
    fixtures,
    collectOnly: args.command === "collect",
  });
  if (result.report) {
    console.log(`Artifacts: ${result.runDir}`);
    enforceRunThresholds(args, result.report);
  }
}

const execute = ["image", "run", "campaign", "benchmark", "collect", "judge"].includes(
  process.argv[2] ?? "",
)
  ? () => withCliSignals(main)
  : main;
execute().catch((error) => {
  if (error instanceof CliInterruptionError) return;
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (process.exitCode !== 130 && process.exitCode !== 143)
    process.exitCode = error instanceof PromotionPolicyError ? 2 : 1;
});
