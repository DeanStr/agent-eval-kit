import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { loadComparisonInput } from "./compare.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { isWithin, prospectiveRealPath, sha256, writeJson } from "./io.js";
import { loadRunState } from "./runner.js";
import type { RunReport } from "./types.js";

export interface PrivacyFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export interface PrivacyLintReport {
  schemaVersion: 1;
  status: "passed" | "failed";
  scannedFiles: number;
  skippedBinaryFiles: number;
  findings: PrivacyFinding[];
}

const rules: Array<{ id: string; expression: RegExp; message: string }> = [
  { id: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, message: "Private-key material" },
  { id: "bearer-token", expression: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i, message: "Bearer credential" },
  { id: "known-api-token", expression: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/, message: "Token matching a known credential format" },
  { id: "secret-assignment", expression: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?cookie|password|secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}/i, message: "Probable secret assignment" },
  { id: "jwt", expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, message: "JSON Web Token" },
  { id: "email-address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, message: "Email address" },
  { id: "home-path", expression: /(?:^|[\s"'])(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/, message: "User-specific absolute home path" },
  { id: "credential-url", expression: /https?:\/\/[^\s/:]+:[^\s/@]+@|[?&](?:token|key|secret|password)=[^&\s]+/i, message: "Credential embedded in a URL" },
];

const PRIVACY_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_PRIVACY_LINE_BYTES = 1024 * 1024;

function likelyTextFile(file: string): boolean {
  const descriptor = fs.openSync(file, "r");
  const sample = Buffer.allocUnsafe(8_192);
  try {
    const bytesRead = fs.readSync(descriptor, sample, 0, sample.length, 0);
    return !sample.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanTextFile(file: string, scanLine: (line: string, lineNumber: number) => void): void {
  const descriptor = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(PRIVACY_SCAN_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 1;
  const checkPendingSize = () => {
    if (Buffer.byteLength(pending) > MAX_PRIVACY_LINE_BYTES) {
      throw new Error(
        `Privacy lint refuses a text line larger than ${MAX_PRIVACY_LINE_BYTES} bytes: ${file}:${lineNumber}`,
      );
    }
  };
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        if (Buffer.byteLength(line) > MAX_PRIVACY_LINE_BYTES) checkPendingSize();
        scanLine(line, lineNumber);
        lineNumber += 1;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      checkPendingSize();
    } while (bytesRead);
    pending += decoder.end();
    checkPendingSize();
    scanLine(pending.replace(/\r$/, ""), lineNumber);
  } finally {
    fs.closeSync(descriptor);
  }
}

function filesUnder(target: string): string[] {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error(`Privacy lint target does not exist: ${resolved}`);
  const files: string[] = [];
  const visit = (candidate: string): void => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Privacy lint refuses symbolic link: ${candidate}`);
    if (stat.isFile()) { files.push(candidate); return; }
    if (!stat.isDirectory()) throw new Error(`Privacy lint refuses non-file target: ${candidate}`);
    for (const entry of fs.readdirSync(candidate).sort()) visit(path.join(candidate, entry));
  };
  visit(resolved);
  return files;
}

export function privacyLint(target: string): PrivacyLintReport {
  const resolved = path.resolve(target);
  const files = filesUnder(resolved);
  const root = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  const findings: PrivacyFinding[] = [];
  let scannedFiles = 0;
  let skippedBinaryFiles = 0;
  for (const file of files) {
    if (!likelyTextFile(file)) { skippedBinaryFiles += 1; continue; }
    scannedFiles += 1;
    scanTextFile(file, (line, lineNumber) => {
      for (const rule of rules) {
        rule.expression.lastIndex = 0;
        if (rule.expression.test(line)) {
          findings.push({
            file: path.relative(root, file).split(path.sep).join("/") || path.basename(file),
            line: lineNumber,
            rule: rule.id,
            message: rule.message,
          });
        }
      }
    });
  }
  return { schemaVersion: 1, status: findings.length ? "failed" : "passed", scannedFiles, skippedBinaryFiles, findings };
}

function publicReport(report: RunReport, artifactRootSha256: string, sourceReportSha256: string) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      runId: report.runId,
      reportSha256: sourceReportSha256,
      artifactRootSha256,
      evaluationFingerprint: report.receipt.evaluationFingerprint,
      split: report.receipt.inputs.selection.split ?? "all",
    },
    project: report.project,
    result: {
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      scorePct: report.scoreWithheld ? null : report.overallScorePct,
      provisionalScorePct: report.overallScorePct,
      coveragePct: report.overallCoveragePct,
      scoreWithheld: report.scoreWithheld,
      gatesPassed: report.gates.passed,
      manualPending: report.manualPending,
    },
    providers: report.providers,
    tags: report.byTag,
    strata: report.byStratum,
    areas: report.areas.map((area) => ({
      id: area.id,
      title: area.title,
      optional: area.optional,
      weight: area.weight,
      scorePct: area.scorePct,
      coveragePct: area.coveragePct,
      gates: area.gates,
      strata: area.byStratum,
      items: area.items.map((item) => ({
        id: item.id,
        verdict: area.unproven.includes(item.id) ? "cannot_judge" : item.verdict,
        confidence: item.confidence,
        source: item.source,
        components: area.unproven.includes(item.id) && item.components
          ? { ...item.components, automatic: "cannot_judge" as const }
          : item.components,
      })),
      cases: area.caseResults.map((item) => ({
        rubricId: item.rubricId,
        caseId: item.caseId,
        strata: item.strata,
        split: item.split,
        verdict: area.unproven.includes(item.rubricId) ? "cannot_judge" : item.verdict,
        confidence: item.confidence,
        points: area.unproven.includes(item.rubricId) ? null : item.points,
      })),
    })),
    exclusions: [
      "prompts and evaluator instructions",
      "scenario transcripts, observations, evidence references, screenshots, and provider events",
      "fixture values and case variables",
      "absolute paths, target URL, authentication state, defects, notes, and grader reasoning",
    ],
  };
}

export function defaultPublicExportOutput(runDir: string): string {
  const resolved = path.resolve(runDir);
  return path.join(path.dirname(path.dirname(resolved)), "exports", path.basename(resolved));
}

export function createPublicExport(options: { runDir: string; output: string }): { directory: string; report: string; lint: PrivacyLintReport } {
  const runDir = fs.realpathSync(path.resolve(options.runDir));
  const output = path.resolve(options.output);
  if (isWithin(runDir, prospectiveRealPath(output))) {
    throw new Error("Public export output must be outside the source run so its sealed artifact index remains valid");
  }
  if (fs.existsSync(output)) throw new Error(`Public export output already exists: ${output}`);
  const state = loadRunState(runDir);
  if (state.status !== "complete") {
    throw new Error(`Only complete runs can be exported; run status is ${state.status}`);
  }
  const integrity = assertArtifactIntegrity(runDir, { require: true })!;
  const reportFile = path.join(runDir, "report.json");
  if (!fs.existsSync(reportFile)) throw new Error(`Run report does not exist: ${reportFile}`);
  const report = loadComparisonInput(reportFile).report;
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staged = path.join(parent, `.aek-public-${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(staged);
  try {
    const exportedReport = path.join(staged, "public-report.json");
    writeJson(exportedReport, publicReport(report, integrity.rootSha256, sha256(fs.readFileSync(reportFile))));
    fs.writeFileSync(path.join(staged, "README.md"), "# Agent Eval Kit public results\n\nThis package intentionally excludes raw evidence, prompts, fixtures, secrets, absolute paths, and evaluator-only material. `privacy-lint.json` records the automated pre-publication scan.\n");
    const lint = privacyLint(staged);
    if (lint.status === "failed") {
      throw new Error(`Public export privacy lint failed:\n  - ${lint.findings.map((item) => `${item.file}:${item.line} ${item.rule}`).join("\n  - ")}`);
    }
    writeJson(path.join(staged, "privacy-lint.json"), lint);
    fs.renameSync(staged, output);
    return { directory: output, report: path.join(output, "public-report.json"), lint };
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}
