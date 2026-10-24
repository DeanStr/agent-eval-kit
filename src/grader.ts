import { isDeepStrictEqual, inspect } from "node:util";

/**
 * Helpers for JSON command checkers (`grader: { type: command, output: json }`).
 * Each checker reports exactly one verdict on stdout and exits 0; a broken checker
 * should throw instead, so the run records an execution error rather than a verdict.
 *
 *   import { expectEqual } from "agent-eval-kit/grader";
 *   expectEqual("two items at 500 cents", total(lines), 1000);
 */

export type CheckerVerdict = "pass" | "partial" | "fail" | "not_found" | "cannot_judge";

export interface CheckerResult {
  verdict: CheckerVerdict;
  /** Invocation, actual result, and expected result. */
  reasoning: string;
  confidence?: "high" | "medium" | "low";
  /** Files beneath AEK_RUN_DIR that support the verdict. */
  evidenceRefs?: string[];
}

type Options = Pick<CheckerResult, "confidence" | "evidenceRefs">;

const verdicts = new Set<CheckerVerdict>(["pass", "partial", "fail", "not_found", "cannot_judge"]);
let reported = false;

/** Write the verdict JSON that AEK reads from stdout. Call once per checker process. */
export function report(result: CheckerResult): void {
  if (reported) throw new Error("A command checker must report exactly one verdict");
  if (!verdicts.has(result.verdict))
    throw new Error(
      `Unknown verdict ${String(result.verdict)}; expected ${[...verdicts].join(", ")}`,
    );
  if (typeof result.reasoning !== "string" || !result.reasoning.trim())
    throw new Error("A checker verdict needs reasoning that states the actual and expected result");
  reported = true;
  process.stdout.write(
    `${JSON.stringify({
      verdict: result.verdict,
      confidence: result.confidence ?? "high",
      reasoning: result.reasoning,
      evidenceRefs: result.evidenceRefs ?? [],
    })}\n`,
  );
}

export const pass = (reasoning: string, options: Options = {}) =>
  report({ verdict: "pass", reasoning, ...options });

export const fail = (reasoning: string, options: Options = {}) =>
  report({ verdict: "fail", reasoning, ...options });

export const partial = (reasoning: string, options: Options = {}) =>
  report({ verdict: "partial", reasoning, ...options });

/** Pass when the condition holds, otherwise fail, with the same reasoning either way. */
export function check(condition: boolean, reasoning: string, options: Options = {}): void {
  report({ verdict: condition ? "pass" : "fail", reasoning, ...options });
}

/**
 * Compare an observed value with an independently specified expectation (deep equality)
 * and report "<label>: expected X; received Y".
 */
export function expectEqual<T>(label: string, actual: T, expected: T, options: Options = {}): void {
  const show = (value: unknown) =>
    inspect(value, { depth: 4, breakLength: Number.POSITIVE_INFINITY });
  check(
    isDeepStrictEqual(actual, expected),
    `${label}: expected ${show(expected)}; received ${show(actual)}.`,
    options,
  );
}
