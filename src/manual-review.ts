import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { cancellationSignal } from "./cancellation.js";
import { readJson, writeJson } from "./io.js";
import { MANUAL_PLACEHOLDER } from "./report.js";
import type { EvalSpec, RunReport } from "./types.js";

type ManualEntries = Record<string, { verdict?: unknown; notes?: unknown; reviewer?: unknown }>;

function manualFile(runDir: string): string {
  return path.join(runDir, "manual-results.json");
}

/** Item IDs in manual-results.json that carry a real verdict rather than the placeholder. */
export function recordedManualVerdicts(runDir: string): string[] {
  const file = manualFile(runDir);
  if (!fs.existsSync(file)) return [];
  const entries = readJson<ManualEntries>(file);
  return Object.entries(entries)
    .filter(
      ([, entry]) =>
        typeof entry?.verdict === "string" &&
        entry.verdict.trim() !== "" &&
        entry.verdict.trim().toLowerCase() !== MANUAL_PLACEHOLDER,
    )
    .map(([id]) => id);
}

const choices: Record<string, "pass" | "partial" | "fail" | "not_found" | "skip"> = {
  p: "pass",
  pass: "pass",
  a: "partial",
  partial: "partial",
  f: "fail",
  fail: "fail",
  n: "not_found",
  "not found": "not_found",
  not_found: "not_found",
  s: "skip",
  skip: "skip",
  "": "skip",
};

/**
 * Ask for each pending manual verdict on stderr and record the answers in
 * manual-results.json. Reads lines from stdin, so answers may also be piped.
 */
export async function promptManualVerdicts(options: {
  runDir: string;
  report: RunReport;
  specs: EvalSpec[];
  reviewer?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<{ recorded: string[]; reviewer: string }> {
  const signal = cancellationSignal();
  signal?.throwIfAborted();
  const output = options.output ?? process.stderr;
  const reader = readline.createInterface({
    input: options.input ?? process.stdin,
    terminal: false,
  });
  const lines = reader[Symbol.asyncIterator]();
  try {
    const ask = async (question: string, item: string): Promise<string> => {
      signal?.throwIfAborted();
      let onAbort: (() => void) | undefined;
      const interrupted = signal
        ? new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          })
        : undefined;
      try {
        output.write(question);
        const next = await (interrupted !== undefined
          ? Promise.race([lines.next(), interrupted])
          : lines.next());
        signal?.throwIfAborted();
        if (next.done)
          throw new Error(
            `Input ended before ${item} was answered; no manual verdicts were recorded`,
          );
        return next.value.trim();
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
    };
    const pending = options.report.areas.flatMap((area) =>
      area.pendingManual.map((id) => {
        const rubric = options.specs
          .find((spec) => spec.id === area.id)
          ?.rubric.find((candidate) => candidate.id === id);
        if (!rubric) throw new Error(`No rubric ${id} exists in area ${area.id}`);
        return { area, rubric, automatic: area.items.find((item) => item.id === id) };
      }),
    );
    if (!pending.length) throw new Error("This run has no pending manual reviews");
    const fallback = process.env.USER?.trim() || process.env.USERNAME?.trim();
    const reviewer =
      options.reviewer?.trim() ||
      (await ask(`Reviewer${fallback ? ` [${fallback}]` : ""}: `, "the reviewer name")) ||
      fallback;
    if (!reviewer) throw new Error("A reviewer name is required to record manual verdicts");
    const answers: ManualEntries = {};
    for (const [index, { area, rubric, automatic }] of pending.entries()) {
      output.write(
        `\n[${index + 1}/${pending.length}] ${area.id}/${rubric.id} (weight ${rubric.weight}) — ${rubric.criterion}\n` +
          `  Pass when: ${rubric.passCriteria}\n` +
          `  Verify:    ${rubric.manualInstructions ?? rubric.evidence ?? rubric.passCriteria}\n` +
          (automatic
            ? `  Automatic: ${automatic.components?.automatic ?? automatic.verdict} — ${automatic.reasoning}\n`
            : ""),
      );
      let verdict: (typeof choices)[string] | undefined;
      while (verdict === undefined) {
        const answer = await ask(
          "  Verdict: [p]ass, p[a]rtial, [f]ail, [n]ot found, [s]kip: ",
          `${area.id}/${rubric.id}`,
        );
        verdict = choices[answer.toLowerCase()];
        if (verdict === undefined)
          output.write(`  Unrecognized answer ${JSON.stringify(answer)}.\n`);
      }
      if (verdict === "skip") continue;
      const notes = await ask("  Notes (optional): ", `${area.id}/${rubric.id} notes`);
      answers[rubric.id] = { verdict, notes, reviewer };
    }
    output.write("\n");
    signal?.throwIfAborted();
    const recorded = Object.keys(answers);
    if (recorded.length) {
      const file = manualFile(options.runDir);
      const existing = fs.existsSync(file) ? readJson<ManualEntries>(file) : {};
      writeJson(file, { ...existing, ...answers });
    }
    return { recorded, reviewer };
  } finally {
    reader.close();
  }
}
