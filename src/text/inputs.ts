import fs from "node:fs";
import path from "node:path";
import { sha256, stableJson } from "../io.js";
import { materializeSpecs } from "../specs.js";
import type { ArtifactReceipt, EvalConfig, EvalSpec, EvalSplit, RunReceipt } from "../types.js";
import { MAX_TEXT_BYTES } from "./contracts.js";

export type TextInputKind = "textCandidates" | "textReferences";
export function textInputDefinitions(specs: EvalSpec[], split?: EvalSplit | "all", kind: TextInputKind = "textReferences") {
  const definitions: Record<string, string> = {};
  for (const spec of materializeSpecs(specs, split)) for (const item of spec.rubric) {
    if (item.grader.type !== "text-pairwise") continue;
    if (kind === "textCandidates") definitions[item.id] = item.grader.candidate;
    else {
      item.grader.references.forEach((reference, index) => { definitions[`${item.id}/${index}`] = reference.file; });
      if (item.grader.styleTarget) definitions[`${item.id}/style`] = item.grader.styleTarget.file;
    }
  }
  return definitions;
}

export function readText(file: string): { bytes: Buffer; text: string } {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error(`Text input must be a regular file <= ${MAX_TEXT_BYTES} bytes: ${file}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`Text input exceeds ${MAX_TEXT_BYTES} bytes: ${file}`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { throw new Error(`Text input must be valid UTF-8: ${file}`, { cause: error }); }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject binary control characters in text inputs.
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error(`Text input is empty or contains binary control characters: ${file}`);
  return { bytes, text };
}

export function textInputs(config: EvalConfig, specs: EvalSpec[], split?: EvalSplit | "all", kind: TextInputKind = "textReferences") {
  const inputs: Record<string, ArtifactReceipt & { file: string }> = {};
  const root = fs.realpathSync(config.project.root);
  for (const [key, configured] of Object.entries(textInputDefinitions(specs, split, kind))) {
    let file: string;
    try { file = fs.realpathSync(path.resolve(root, configured)); }
    catch (error) { throw new Error(`Text input ${key} is unavailable: ${configured}. Save the text file before running AEK.`, { cause: error }); }
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Text input ${key} escapes project.root`);
    const { bytes } = readText(file);
    inputs[key] = { file, sha256: sha256(bytes), bytes: bytes.length };
  }
  return inputs;
}

export function validateTextInputs(config: EvalConfig, specs: EvalSpec[], split?: EvalSplit | "all"): void {
  textInputs(config, specs, split, "textCandidates");
  textInputs(config, specs, split, "textReferences");
}

export function textInputPath(runDir: string, key: string, kind: TextInputKind): string {
  return path.join(runDir, "inputs", kind, `${sha256(key)}.txt`);
}

export function snapshotTextInputs(config: EvalConfig, specs: EvalSpec[], runDir: string, split: EvalSplit | "all", expected: RunReceipt["inputs"]) {
  for (const kind of ["textCandidates", "textReferences"] as const) {
    const inputs = textInputs(config, specs, split, kind);
    const receipts = Object.fromEntries(Object.entries(inputs).map(([key, { sha256, bytes }]) => [key, { sha256, bytes }]));
    if (stableJson(receipts) !== stableJson(expected[kind])) throw new Error(`Text inputs changed after receipt creation: ${kind}; start a new run`);
    for (const [key, input] of Object.entries(inputs)) {
      const file = textInputPath(runDir, key, kind), { bytes } = readText(input.file);
      if (sha256(bytes) !== input.sha256) throw new Error(`Text input changed during snapshot: ${key}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: "wx" });
    }
  }
}

export function readTextSnapshot(runDir: string, receipt: RunReceipt, key: string, kind: TextInputKind) {
  const file = textInputPath(runDir, key, kind), result = readText(file), expected = receipt.inputs[kind]?.[key];
  if (!expected || expected.sha256 !== sha256(result.bytes) || expected.bytes !== result.bytes.length) throw new Error(`Text input receipt mismatch: ${key}`);
  return { ...result, ref: path.relative(runDir, file).split(path.sep).join("/") };
}
