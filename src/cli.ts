#!/usr/bin/env node
import fs from "node:fs";
import { validateVisualInputs } from "./visual/inputs.js";
import { validateTextInputs } from "./text/inputs.js";
import path from "node:path";
import YAML from "yaml";
import { captureAuth } from "./auth.js";
import { throwIfCancelled, withCliSignals } from "./cancellation.js";
import { listPromotedBaselines, loadPromotedBaseline, promoteBaseline } from "./baselines.js";
import {
  buildCampaignReport,
  campaignRunRecord,
  createCampaignDirectory,
  type CampaignRunRecord,
  writeCampaignArtifacts,
} from "./campaign.js";
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
import { loadConfig, type ConfigOverrides } from "./config.js";
import { doctor } from "./doctor.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { isWithin, prospectiveRealPath, readJson, sha256, stableJson } from "./io.js";
import {
  finalizeReport,
  recoverInterruptedReportUpdate,
  writeReportArtifactsRecoverably,
} from "./report.js";
import { buildRunReceipt } from "./receipts.js";
import { loadRunState, runEvaluation, withRunLock } from "./runner.js";
import { buildReport, scoreArea } from "./scoring.js";
import { assertScenarioSelectors, assertScenarioTargetCompatibility, loadFixtures, loadSpecFile, loadSpecs, materializeSpecs, selectSpecs } from "./specs.js";
import { initializeProject } from "./templates.js";
import { createPublicExport, defaultPublicExportOutput, privacyLint } from "./public-export.js";
import { PROVIDERS, type EvalConfig, type EvalSplit, type ProviderId, type RunReport } from "./types.js";
import { KIT_VERSION } from "./version.js";
import { assertEvaluationPlatform } from "./platform.js";

interface Args { command: string; flags: Record<string, string | boolean>; positionals: string[] }

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const equal = value.indexOf("=");
    if (equal > 2) { flags[value.slice(2, equal)] = value.slice(equal + 1); continue; }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; index++; }
    else flags[key] = true;
  }
  return { command, flags, positionals };
}

const booleanFlags = new Set([
  "include-images", "allow-incompatible", "dry-run", "fail-on-regression", "headed", "help", "include-optional", "public",
]);

function validateCliShape(args: Args): void {
  const knownCommands = new Set([
    "auth", "baseline", "campaign", "compare", "doctor", "export", "finalize", "init", "list", "privacy", "rescore", "run", "validate", "verify",
  ]);
  if (!knownCommands.has(args.command)) throw new Error(`Unknown command ${args.command}\n\n${help}`);
  if (args.command === "campaign" && args.positionals[0] && args.positionals[0] !== "compare") {
    throw new Error(`Unknown campaign subcommand ${args.positionals[0]}; expected \`compare\` or no subcommand`);
  }
  const configOverrides = ["config", "url", "max-turns", "agent", "judge", "agent-model", "judge-model", "headed"];
  const runFlags = [
    ...configOverrides, "areas", "scenarios", "include-optional", "split", "resume", "dry-run", "fail-under-score", "fail-under-coverage",
  ];
  let allowed: string[] = [];
  switch (args.command) {
    case "init": allowed = ["kind"]; break;
    case "validate":
    case "list": allowed = ["config"]; break;
    case "doctor": allowed = ["config", "providers"]; break;
    case "verify": allowed = ["run"]; break;
    case "privacy": allowed = ["path"]; break;
    case "export": allowed = ["public", "run", "output"]; break;
    case "auth": allowed = ["config", "url", "headed", "persona", "at", "click"]; break;
    case "rescore": allowed = ["run", "config", "fail-under-score", "fail-under-coverage"]; break;
    case "finalize": allowed = ["run", "config", "reviewer", "fail-under-score", "fail-under-coverage"]; break;
    case "compare": allowed = ["baseline", "baseline-name", "candidate", "config", "output", "fail-on-regression", "max-score-drop", "max-coverage-drop", "allow-incompatible"]; break;
    case "baseline": allowed = args.positionals[0] === "promote" ? ["run", "name", "reviewer", "config", "include-images"] : ["config"]; break;
    case "campaign": allowed = args.positionals[0] === "compare"
      ? ["baseline", "candidate", "output", "fail-on-regression", "allow-incompatible"]
      : [...runFlags, "repetitions", "output"];
      break;
    case "run": allowed = runFlags; break;
  }
  allowed.push("help");
  const unknown = Object.keys(args.flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length) throw new Error(`Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}`);
  for (const [flag, value] of Object.entries(args.flags)) {
    if (booleanFlags.has(flag) && value !== true) throw new Error(`--${flag} does not take a value`);
  }
  const maximumPositionals = args.command === "init" || ["baseline", "campaign", "privacy"].includes(args.command) ? 1 : 0;
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
    if (!fs.existsSync(path.join(runDir, "artifact-index.json")) || !isWithin(runDir, resolvedOutput)) continue;
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

  init [directory] [--kind web|repository|command|artifact]
                                   Create a starter kit and onboarding guide
  validate [--config file]         Validate configuration, specs, and fixture paths
  list [--config file]             List areas, scenarios, graders, weights, and tags
  doctor [--config file] [--providers a,b]
                                    Check required CLIs, login, and browser support
  run [--config file]              Execute scenarios, graders, and reports
      [--url https://target] [--max-turns n (provider turns / Codex MCP calls)]
      [--areas a,b] [--scenarios x,y] [--include-optional]
      [--split development|evaluation|all]
      [--agent codex|claude|grok] [--judge codex|claude|grok]
      [--agent-model id] [--judge-model id] [--headed] [--dry-run]
      [--resume run-directory] [--fail-under-score pct]
      [--fail-under-coverage pct]
  campaign [--repetitions n]       Run the same evaluation repeatedly, sequentially
      [run flags] [--output directory]
  campaign compare --baseline campaign --candidate campaign
      [--output directory] [--fail-on-regression] [--allow-incompatible]
  verify --run directory           Verify checksums for retained run artifacts
  export --public --run directory  Create a minimal, privacy-linted shareable package
      [--output directory]
  privacy lint --path target       Scan a file or directory for likely private data
  auth --persona name              Capture a browser login session
      [--at /login] [--click "Demo login"]
  rescore --run directory          Reapply current scoring/specs without an agent call
  finalize --run directory         Merge manual results and append review provenance
      [--reviewer name]
  baseline promote --run dir --name name --reviewer name [--include-images]
  baseline list [--config file]    Manage append-only promoted baseline snapshots
  compare --baseline run --candidate run
                                    Write JSON and HTML baseline comparison
      [--baseline-name name] [--config file]
      [--output directory] [--fail-on-regression]
      [--max-score-drop points] [--max-coverage-drop points]
      [--allow-incompatible]

The --fail-under-* gates also work with rescore and finalize. Rubric items with
gate: true are always enforced. A failed CI gate uses exit code 2 while still
preserving all generated artifacts. Compare requires compatible receipts unless
--allow-incompatible is explicit.

Provider adapters remove API-key environment variables before invocation, so
Codex, Claude Code, and Grok Build use their saved subscription login.
`;

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === true) throw new Error(`--${name} requires a value`);
  return typeof value === "string" ? value : undefined;
}

function csv(value?: string): string[] | undefined {
  return value?.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveIntegerFlag(args: Args, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
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
): { file: string; config: EvalConfig; overrides: ConfigOverrides } {
  const file = path.resolve(stringFlag(args, "config") ?? fallbackFile);
  const overrides: ConfigOverrides = { ...inheritedOverrides };
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
  return { file, config: loadConfig(file, overrides), overrides };
}

function init(directory: string, kind: string = "web"): void {
  const files = initializeProject(directory, kind);
  console.log(`Created ${files.map((file) => path.relative(process.cwd(), file)).join(", ")}`);
  console.log(`Next: follow ${path.join(directory, "evals", "ONBOARDING.md")} to customize, pilot, and calibrate this kit before promoting a baseline.`);
}

function enforceRunThresholds(args: Args, report: RunReport): void {
  const failures = evaluateCiThresholds(report, {
    minimumScore: percentageFlag(args, "fail-under-score"),
    minimumCoverage: percentageFlag(args, "fail-under-coverage"),
  });
  for (const failure of failures) console.error(`CI threshold failed: ${failure}`);
  if (failures.length) process.exitCode = 2;
}

function loadRunConfig(args: Args, runDir: string) {
  const state = loadRunState(runDir);
  const file = path.resolve(stringFlag(args, "config") ?? state.configFile);
  return { file, config: loadConfig(file, state.configOverrides), state };
}

function originalScoring(runDir: string): EvalConfig["scoring"] {
  const snapshot = path.join(runDir, "inputs", "config.resolved.yaml");
  if (!fs.existsSync(snapshot)) throw new Error(`Original resolved config snapshot is missing: ${snapshot}`);
  const parsed = YAML.parse(fs.readFileSync(snapshot, "utf8")) as { scoring?: Partial<EvalConfig["scoring"]> };
  const partialCredit = parsed?.scoring?.partialCredit;
  const minimumCoverage = parsed?.scoring?.minimumCoverage;
  if (
    typeof partialCredit !== "number" || !Number.isFinite(partialCredit) || partialCredit < 0 || partialCredit > 1 ||
    typeof minimumCoverage !== "number" || !Number.isFinite(minimumCoverage) || minimumCoverage < 0 || minimumCoverage > 100
  ) {
    throw new Error(`Original resolved config snapshot has invalid scoring settings: ${snapshot}`);
  }
  return { partialCredit, minimumCoverage };
}

function assertFinalizeSpecsUnchanged(report: RunReport, specs: ReturnType<typeof loadSpecs>): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const area of report.areas) {
    const spec = byId.get(area.id);
    if (!spec) throw new Error(`Current specs do not contain prior area ${area.id}`);
    const expected = report.receipt.inputs.specs[spec.id];
    if (!expected || sha256(fs.readFileSync(spec.sourceFile)) !== expected.sha256) {
      throw new Error(`Spec ${spec.id} changed since evidence was judged. Use rescore intentionally before finalizing manual results.`);
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
    scenarioIds: report.receipt.inputs.selection.scenarios,
    split: selectedSplit,
    evidenceProvenance: report.receipt,
  });
  if (current.inputs.methodSha256 !== report.receipt.inputs.methodSha256) {
    throw new Error("Resolved evaluator config changed since the report was last scored. Run rescore before finalizing manual results.");
  }
}

function judgementDefinition(spec: ReturnType<typeof loadSpecFile>): unknown {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    scenarios: spec.scenarios,
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

function assertRescoreConfigCompatible(runDir: string, report: RunReport, config: EvalConfig): void {
  const snapshot = path.join(runDir, "inputs", "config.resolved.yaml");
  if (!fs.existsSync(snapshot)) throw new Error(`Original resolved config snapshot is missing: ${snapshot}`);
  const collectionConfig = { ...config, scoring: originalScoring(runDir) };
  if (sha256(stableJson(collectionConfig)) !== report.receipt.inputs.config.sha256) {
    throw new Error(
      "Resolved config changed outside scoring. Rescore permits only scoring settings and compatible spec weighting metadata; start a new run for target, provider, browser, fixture, variable, instruction, or path changes.",
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) { console.log(help); return; }
  validateCliShape(args);
  if (args.flags.help) { console.log(help); return; }
  if (args.command === "run" || args.command === "auth" ||
      (args.command === "campaign" && args.positionals[0] !== "compare")) assertEvaluationPlatform();
  if (args.command === "init") { init(args.positionals[0] ?? ".", stringFlag(args, "kind")); return; }

  if (args.command === "verify") {
    const runDir = path.resolve(stringFlag(args, "run") ?? (() => { throw new Error("verify requires --run <directory>"); })());
    const index = assertArtifactIntegrity(runDir, { require: true })!;
    console.log(`Verified ${index.entries.length} artifacts; root ${index.rootSha256}`);
    return;
  }

  if (args.command === "privacy") {
    if (args.positionals[0] !== "lint") throw new Error("privacy requires `lint`");
    const target = path.resolve(stringFlag(args, "path") ?? (() => { throw new Error("privacy lint requires --path <file-or-directory>"); })());
    const lint = privacyLint(target);
    for (const finding of lint.findings) console.error(`${finding.file}:${finding.line}\t${finding.rule}\t${finding.message}`);
    console.log(`Privacy lint ${lint.status}: ${lint.scannedFiles} text files scanned, ${lint.skippedBinaryFiles} binary files skipped, ${lint.findings.length} finding(s).`);
    if (lint.status === "failed") process.exitCode = 2;
    return;
  }

  if (args.command === "export") {
    if (!args.flags.public) throw new Error("export currently requires --public to make the sanitization boundary explicit");
    const runDir = path.resolve(stringFlag(args, "run") ?? (() => { throw new Error("export --public requires --run <directory>"); })());
    const output = stringFlag(args, "output") ?? defaultPublicExportOutput(runDir);
    const exported = createPublicExport({ runDir, output });
    console.log(`Public export: ${exported.directory}`);
    console.log(`Privacy lint passed: ${exported.lint.scannedFiles} text files scanned; ${exported.lint.skippedBinaryFiles} binary files skipped.`);
    return;
  }

  if (args.command === "campaign" && args.positionals[0] === "compare") {
    const baselineInput = stringFlag(args, "baseline") ?? (() => { throw new Error("campaign compare requires --baseline <campaign>"); })();
    const candidateInput = stringFlag(args, "candidate") ?? (() => { throw new Error("campaign compare requires --candidate <campaign>"); })();
    const baseline = loadCampaign(baselineInput);
    const candidate = loadCampaign(candidateInput);
    const allowIncompatible = Boolean(args.flags["allow-incompatible"]);
    const comparison = compareCampaigns(baseline.report, candidate.report, { allowIncompatible });
    const output = stringFlag(args, "output") ?? defaultCampaignComparisonOutput(candidate.file, baseline.report.campaignId);
    const artifacts = writeCampaignComparisonArtifacts(output, comparison);
    console.log(`Compared campaigns ${baseline.report.campaignId} → ${candidate.report.campaignId}: ${comparison.summary.improved} improved, ${comparison.summary.regressed} regressed; mean paired-case delta ${comparison.pairedCases.meanDelta ?? "n/a"}.`);
    console.log(`Artifacts: ${artifacts.json}, ${artifacts.html}`);
    const failures = campaignComparisonFailures(comparison, {
      failOnRegression: Boolean(args.flags["fail-on-regression"]),
      requireCompatible: !allowIncompatible,
    });
    for (const failure of failures) console.error(`CI campaign comparison failed: ${failure}`);
    if (failures.length) process.exitCode = 2;
    return;
  }

  if (args.command === "baseline") {
    const action = args.positionals[0];
    if (action === "promote") {
      const runDir = path.resolve(stringFlag(args, "run") ?? (() => { throw new Error("baseline promote requires --run <directory>"); })());
      const name = stringFlag(args, "name") ?? (() => { throw new Error("baseline promote requires --name <name>"); })();
      const reviewer = stringFlag(args, "reviewer") ?? (() => { throw new Error("baseline promote requires --reviewer <name>"); })();
      const { config } = loadRunConfig(args, runDir);
      const promoted = promoteBaseline({ config, runDir, name, reviewer, includeImages: Boolean(args.flags["include-images"]) });
      console.log(`Promoted ${promoted.report.runId} as ${name} snapshot ${promoted.promotion.snapshotId}`);
      console.log(`Snapshot: ${promoted.directory}`);
      return;
    }
    if (action === "list") {
      const { config } = configFor(args);
      const baselines = listPromotedBaselines(config);
      if (!baselines.length) console.log("No promoted baselines.");
      for (const baseline of baselines) {
        console.log(`${baseline.name}\t${baseline.sourceRunId}\t${baseline.promotedAt}\t${baseline.reviewer}\t${baseline.snapshotId}`);
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
      throw new Error("compare requires --candidate and exactly one of --baseline or --baseline-name");
    }
    const candidate = loadComparisonInput(candidateInput);
    assertArtifactIntegrity(path.dirname(candidate.file), { require: true });
    assertCompletedComparisonRun(candidate.file, "candidate");
    let baseline: ReturnType<typeof loadComparisonInput>;
    if (baselineName) {
      const stateFile = path.join(path.dirname(candidate.file), "run-state.json");
      const fallbackConfig = fs.existsSync(stateFile)
        ? readJson<{ configFile: string }>(stateFile).configFile
        : "evalkit.yaml";
      const configFile = path.resolve(stringFlag(args, "config") ?? fallbackConfig);
      baseline = loadPromotedBaseline(loadConfig(configFile), baselineName);
    } else {
      baseline = loadComparisonInput(baselineInput!);
      assertArtifactIntegrity(path.dirname(baseline.file), { require: true });
      assertCompletedComparisonRun(baseline.file, "baseline");
    }
    const allowIncompatible = Boolean(args.flags["allow-incompatible"]);
    const comparison = compareReports(baseline.report, candidate.report, { allowIncompatible });
    const output = stringFlag(args, "output") ?? defaultComparisonOutput(candidate.file, baseline.report.runId);
    assertComparisonOutputLocation(output, [candidate.file, baseline.file]);
    const artifacts = writeComparisonArtifacts(output, comparison);
    console.log(
      `Compared ${baseline.report.runId} → ${candidate.report.runId}: score ${comparison.overall.scorePct.delta === null ? "n/a" : `${comparison.overall.scorePct.delta >= 0 ? "+" : ""}${comparison.overall.scorePct.delta}`} points; coverage ${comparison.overall.coveragePct.delta === null ? "n/a" : `${comparison.overall.coveragePct.delta >= 0 ? "+" : ""}${comparison.overall.coveragePct.delta}`} points`,
    );
    console.log(`Artifacts: ${artifacts.json}, ${artifacts.html}`);
    const failures = comparisonFailures(comparison, {
      failOnRegression: Boolean(args.flags["fail-on-regression"]),
      maxScoreDrop: percentageFlag(args, "max-score-drop"),
      maxCoverageDrop: percentageFlag(args, "max-coverage-drop"),
      requireCompatible: !allowIncompatible,
    });
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
      if (!(PROVIDERS as readonly string[]).includes(value)) throw new Error(`Unknown provider ${value}`);
      return value as ProviderId;
    });
    const configFile = path.resolve(stringFlag(args, "config") ?? "evalkit.yaml");
    let configuredProviders: ProviderId[] | undefined;
    let requireBrowser = false;
    if (stringFlag(args, "config") || fs.existsSync(configFile)) {
      const config = loadConfig(configFile);
      const specs = loadSpecs(config.paths.specs);
      assertScenarioTargetCompatibility(specs, config.target);
      configuredProviders = [...new Set([config.agent.provider, config.judge.provider])];
      requireBrowser = specs.some((spec) => spec.scenarios.some((scenario) =>
        (scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")) === "browser"
      ));
    }
    const checks = doctor({
      providers: requested ? [...new Set(requested)] : configuredProviders,
      requireBrowser,
    });
    for (const check of checks) {
      const marker = check.ok ? "✓" : check.required ? "✗" : "○";
      console.log(`${marker} ${check.name}${check.required ? "" : " (optional)"}: ${check.detail}`);
    }
    if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
    return;
  }

  if (args.command === "rescore" || args.command === "finalize") {
    const runDir = path.resolve(stringFlag(args, "run") ?? (() => { throw new Error(`${args.command} requires --run`); })());
    await withRunLock(runDir, async () => {
      const state = loadRunState(runDir);
      if (state.status !== "complete") {
        throw new Error(`Only complete runs can be ${args.command === "rescore" ? "rescored" : "finalized"}; run status is ${state.status}`);
      }
      if (recoverInterruptedReportUpdate(runDir)) {
        console.log(`Recovered interrupted report update in ${runDir}`);
      }
      assertArtifactIntegrity(runDir, { require: true });
      const { config } = loadRunConfig(args, runDir);
      const prior = loadComparisonInput(path.join(runDir, "report.json")).report;
      if (args.command === "rescore") assertRescoreConfigCompatible(runDir, prior, config);
      const sourceSpecs = loadSpecs(config.paths.specs);
      assertScenarioTargetCompatibility(sourceSpecs, config.target);
      const receiptSpecs = sourceSpecs.filter((spec) => prior.areas.some((area) => area.id === spec.id));
      const receiptSelection = prior.receipt.inputs.selection;
      const selectedSplit = receiptSelection.split ?? "all";
      const specs = materializeSpecs(receiptSpecs, selectedSplit);
      if (args.command === "finalize") {
        assertFinalizeSpecsUnchanged(prior, receiptSpecs);
        assertFinalizeConfigUnchanged(prior, config, receiptSpecs, selectedSplit);
        const report = finalizeReport({ runDir, report: prior, specs, config, reviewer: stringFlag(args, "reviewer") });
        console.log(`Finalized: ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage; ${report.manualPending} pending`);
        enforceRunThresholds(args, report);
        return;
      }
      assertRescoreSpecsCompatible(runDir, prior, receiptSpecs);
      const receipt = buildRunReceipt({
        config,
        specs: receiptSpecs,
        fixtures: undefined,
        scenarioIds: receiptSelection.scenarios,
        split: selectedSplit,
        evidenceProvenance: prior.receipt,
      });
      const areas = prior.areas.map((area) => {
        const spec = specs.find((candidate) => candidate.id === area.id);
        if (!spec) throw new Error(`Current specs do not contain prior area ${area.id}`);
        return scoreArea({ spec, judgements: area.items, evidence: area.scenarios, config, defects: area.defects, notes: area.notes, caseResults: area.caseResults });
      });
      const report = buildReport({ runId: prior.runId, startedAt: prior.startedAt, config, areas, receipt });
      writeReportArtifactsRecoverably(runDir, report, specs);
      console.log(`Rescored: ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage`);
      enforceRunThresholds(args, report);
    });
    return;
  }

  const resumeFlag = args.command === "run" ? stringFlag(args, "resume") : undefined;
  const resumeState = resumeFlag ? loadRunState(path.resolve(resumeFlag)) : undefined;
  const { file, config, overrides } = configFor(
    args,
    resumeState?.configFile ?? "evalkit.yaml",
    resumeState?.configOverrides,
  );
  const allSpecs = loadSpecs(config.paths.specs);
  assertScenarioTargetCompatibility(allSpecs, config.target);
  if (args.command === "validate") {
    await validateVisualInputs(config, allSpecs);
    validateTextInputs(config, allSpecs);
    loadFixtures(config.paths.fixtures);
    const templates = allSpecs.reduce((n, spec) => n + spec.scenarios.length, 0);
    const executions = materializeSpecs(allSpecs).reduce((n, spec) => n + spec.scenarios.length, 0);
    console.log(`Valid: ${file}; ${allSpecs.length} areas, ${templates} scenario templates, ${executions} executable cases, ${allSpecs.reduce((n, spec) => n + spec.rubric.length, 0)} rubric items.`);
    return;
  }
  if (args.command === "list") {
    for (const spec of allSpecs) {
      console.log(`${spec.id.padEnd(20)} w${String(spec.weight).padEnd(5)} ${spec.title}${spec.optional ? " (optional)" : ""}`);
      for (const scenario of spec.scenarios) console.log(`  scenario ${scenario.id.padEnd(18)} ${scenario.kind ?? "auto"}  ${scenario.name}`);
      for (const scenario of spec.scenarios) {
        for (const scenarioCase of scenario.cases ?? []) {
          console.log(`    case   ${scenarioCase.id.padEnd(18)} ${scenarioCase.split ?? scenario.split ?? "all"} [${scenarioCase.strata.join(", ") || "no strata"}]`);
        }
      }
      for (const rubric of spec.rubric) console.log(`  rubric   ${rubric.id.padEnd(18)} w${rubric.weight} ${rubric.grader.type}${rubric.gate ? " GATE" : ""} [${rubric.tags.join(", ")}]`);
    }
    return;
  }
  if (args.command === "auth") {
    const persona = stringFlag(args, "persona");
    if (!persona) throw new Error("auth requires --persona <name>");
    const saved = await captureAuth({ config, persona, startAt: stringFlag(args, "at"), clickText: stringFlag(args, "click") });
    console.log(`Saved ${persona} browser session to ${saved}`);
    return;
  }
  if (args.command !== "run" && args.command !== "campaign") throw new Error(`Unknown command ${args.command}\n\n${help}`);

  const selected = selectSpecs(
    allSpecs,
    csv(stringFlag(args, "areas")) ?? resumeState?.selectedAreas,
    Boolean(args.flags["include-optional"]),
  );
  const fixtures = loadFixtures(config.paths.fixtures);
  const selectedSplit = args.flags.split === undefined ? resumeState?.selectedSplit ?? splitFlag(args) : splitFlag(args);
  const scenarioIds = csv(stringFlag(args, "scenarios")) ?? resumeState?.selectedScenarios;
  assertScenarioSelectors(materializeSpecs(selected, selectedSplit), scenarioIds, selectedSplit);
  if (args.command === "campaign") {
    if (args.flags["dry-run"] || args.flags.resume) throw new Error("campaign does not support --dry-run or --resume");
    const repetitions = positiveIntegerFlag(args, "repetitions") ?? 3;
    if (repetitions < 2) throw new Error("--repetitions must be at least 2 for a campaign");
    const thresholds = {
      minimumScore: percentageFlag(args, "fail-under-score"),
      minimumCoverage: percentageFlag(args, "fail-under-coverage"),
    };
    const directory = createCampaignDirectory(config, stringFlag(args, "output"));
    const startedAt = new Date().toISOString();
    const campaignId = path.basename(directory);
    const runs: CampaignRunRecord[] = [];
    const reports: RunReport[] = [];
    for (let ordinal = 1; ordinal <= repetitions; ordinal++) {
      throwIfCancelled();
      console.log(`Campaign ${campaignId}: repetition ${ordinal}/${repetitions}`);
      try {
        const result = await runEvaluation({
          config,
          configFile: file,
          specs: selected,
          fixtures,
          scenarioIds,
          split: selectedSplit,
          configOverrides: overrides,
          ignoredTargetPaths: [directory],
        });
        if (!result.report) throw new Error("Evaluation completed without a report");
        reports.push(result.report);
        runs.push(campaignRunRecord(ordinal, result.runDir, result.report));
      } catch (error) {
        runs.push({
          ordinal,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      writeCampaignArtifacts(directory, buildCampaignReport({
        campaignId,
        project: config.project.name,
        startedAt,
        plannedRepetitions: repetitions,
        runs,
      }));
      throwIfCancelled();
    }
    const campaign = buildCampaignReport({
      campaignId,
      project: config.project.name,
      startedAt,
      plannedRepetitions: repetitions,
      runs,
    });
    const artifacts = writeCampaignArtifacts(directory, campaign);
    console.log(`Campaign complete: ${campaign.coverage.completedRuns}/${repetitions} runs; artifacts ${artifacts.json}, ${artifacts.html}`);
    const failures = reports.flatMap((report, index) =>
      evaluateCiThresholds(report, thresholds).map((failure) => `repetition ${runs.filter((run) => run.status === "complete")[index]?.ordinal}: ${failure}`),
    );
    if (campaign.compatibility.status !== "compatible") {
      failures.push(`campaign inputs are ${campaign.compatibility.status}; aggregate measurements are unavailable`);
    }
    for (const failure of failures) console.error(`CI campaign failed: ${failure}`);
    if (runs.some((run) => run.status === "failed")) process.exitCode = 1;
    else if (failures.length) process.exitCode = 2;
    return;
  }
  const result = await runEvaluation({
    config,
    configFile: file,
    specs: selected,
    fixtures,
    scenarioIds,
    split: selectedSplit,
    configOverrides: overrides,
    resumeDir: stringFlag(args, "resume"),
    dryRun: Boolean(args.flags["dry-run"]),
  });
  if (result.report) {
    console.log(`Artifacts: ${result.runDir}`);
    enforceRunThresholds(args, result.report);
  }
}

const execute = ["run", "campaign"].includes(process.argv[2]) ? () => withCliSignals(main) : main;
execute().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
});
