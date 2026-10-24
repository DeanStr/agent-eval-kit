import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandOutputValidator, EXIT_CODE_VERDICTS } from "./graders.js";
import { safeName } from "./io.js";
import { shellInvocation, spawnCaptured } from "./providers/process.js";
import { didYouMean } from "./suggest.js";
import type { EvalConfig, EvalSpec, JudgedItem, RubricItem, Verdict } from "./types.js";

export interface CheckResult {
  areaId: string;
  itemId: string;
  durationMs: number;
  verdict?: Verdict;
  confidence?: JudgedItem["confidence"];
  reasoning?: string;
  /** A checker execution error: nonzero JSON exit, invalid output, timeout, or signal. */
  error?: string;
  stderr?: string;
}

type CommandItem = RubricItem & { grader: Extract<RubricItem["grader"], { type: "command" }> };

/**
 * Select command checkers by `ID` or `area/ID`. Checkers that read scenario evidence or run
 * inside a run directory cannot execute standalone, so they are rejected with the run command.
 */
export function selectCheckItems(
  specs: EvalSpec[],
  selectors: string[],
): Array<{ spec: EvalSpec; item: CommandItem }> {
  const all = specs.flatMap((spec) => spec.rubric.map((item) => ({ spec, item })));
  const standalone = (entry: { spec: EvalSpec; item: RubricItem }) => {
    const { spec, item } = entry;
    const name = `${spec.id}/${item.id}`;
    if (item.applicability?.applicable === false)
      throw new Error(
        `${name} is declared inapplicable: ${item.applicability.reason}. Update the applicability declaration before checking it.`,
      );
    if (item.grader.type !== "command")
      throw new Error(
        `${name} uses a ${item.grader.type} grader; aek check runs only command checkers. Use \`aek run --areas ${spec.id}\`.`,
      );
    if (item.scenarios.length)
      throw new Error(
        `${name} reads evidence from scenario ${item.scenarios.join(", ")}; use \`aek run --areas ${spec.id} --scenarios ${item.scenarios.join(",")}\`.`,
      );
    if (item.grader.cwd === "run")
      throw new Error(`${name} runs inside a run directory (cwd: run); use \`aek run\`.`);
    return entry as { spec: EvalSpec; item: CommandItem };
  };
  if (!selectors.length) {
    const found = all
      .filter(
        ({ item }) =>
          item.applicability?.applicable !== false &&
          item.grader.type === "command" &&
          !item.scenarios.length &&
          item.grader.cwd !== "run",
      )
      .map(standalone);
    if (!found.length)
      throw new Error(
        "No applicable standalone command checkers are defined. Applicable command graders without scenarios or cwd: run can be checked.",
      );
    return found;
  }
  return selectors.map((selector) => {
    const parts = selector.split("/");
    if (parts.length > 2 || parts.some((part) => !part))
      throw new Error(
        `Invalid rubric selector ${JSON.stringify(selector)}; expected ID or area/ID with nonempty components. Run \`aek list\` to see rubric IDs.`,
      );
    const [area, id] = parts.length === 2 ? parts : [undefined, selector];
    const matches = all.filter(
      ({ spec, item }) => item.id === id && (area === undefined || spec.id === area),
    );
    if (matches.length > 1)
      throw new Error(
        `${selector} matches ${matches.map(({ spec, item }) => `${spec.id}/${item.id}`).join(", ")}; use area/ID`,
      );
    const match = matches[0];
    if (!match)
      throw new Error(
        `No rubric item ${selector}.${didYouMean(
          selector,
          all.flatMap(({ spec, item }) => [item.id, `${spec.id}/${item.id}`]),
        )} Run \`aek list\` to see rubric IDs.`,
      );
    return standalone(match);
  });
}

/** Execute one command checker exactly as a run would, without sealing inputs or retaining output. */
export async function runCheck(
  config: EvalConfig,
  spec: EvalSpec,
  item: CommandItem,
): Promise<CheckResult> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-check-"));
  const started = Date.now();
  const base = { areaId: spec.id, itemId: item.id };
  try {
    const output = path.join(scratch, "output");
    fs.mkdirSync(output);
    const shell = shellInvocation(item.grader.command);
    const timeoutSeconds = item.grader.timeoutSeconds ?? 300;
    const result = await spawnCaptured({
      command: shell.command,
      args: shell.args,
      cwd:
        !item.grader.cwd || item.grader.cwd === "project"
          ? config.project.root
          : path.resolve(config.project.root, item.grader.cwd),
      env: {
        ...process.env,
        AEK_PROJECT_ROOT: config.project.root,
        // Checkers may write evidence here; aek check discards it afterwards.
        AEK_RUN_DIR: output,
        AEK_RUBRIC_ID: item.id,
        AEK_CHECK: "1",
      },
      timeoutSeconds,
      stdoutFile: path.join(scratch, `${safeName(item.id)}.stdout.txt`),
      stderrFile: path.join(scratch, `${safeName(item.id)}.stderr.txt`),
    });
    const durationMs = Date.now() - started;
    const failure = (error: string): CheckResult => ({
      ...base,
      durationMs,
      error,
      ...(result.stderr.trim() ? { stderr: result.stderr.trim().slice(-4000) } : {}),
    });
    if (result.timedOut) return failure(`timed out after ${timeoutSeconds}s`);
    if (result.exitCode === null)
      return failure(`terminated by ${result.signal ?? "an unknown signal"}`);
    if (item.grader.output === "exit-code") {
      const verdict = EXIT_CODE_VERDICTS[result.exitCode];
      if (!verdict) return failure(`unexpected exit code ${result.exitCode}; expected 0 through 4`);
      return {
        ...base,
        durationMs,
        verdict,
        confidence: "high",
        reasoning: result.stdout.trim() || `exit ${result.exitCode}`,
      };
    }
    if (result.exitCode !== 0)
      return failure(`JSON checker exited ${result.exitCode}; expected exit 0`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return failure(
        `expected one JSON object on stdout; received ${JSON.stringify(result.stdout.slice(0, 200))}`,
      );
    }
    const checked = commandOutputValidator.safeParse(parsed);
    if (!checked.success)
      return failure(
        `invalid checker output: ${checked.error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`).join("; ")}`,
      );
    return {
      ...base,
      durationMs,
      verdict: checked.data.verdict,
      confidence: checked.data.confidence,
      reasoning: checked.data.reasoning,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
