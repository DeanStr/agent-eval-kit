import path from "node:path";
import { stableJson, writeJson } from "../io.js";
import { buildRunReceipt } from "../receipts.js";
import type { RunReceipt } from "../types.js";
import type { RunState } from "./state.js";

/** Owns the canonical receipt across target lifecycle and checker mutations. */
export class RunReceipts {
  private receipt: RunReceipt;

  get current(): RunReceipt { return this.receipt; }

  constructor(private readonly inputs: Parameters<typeof buildRunReceipt>[0], private readonly runDir: string) {
    this.receipt = buildRunReceipt(inputs);
  }

  refresh(phase: string, state: RunState, priorEvidenceEligible: boolean): void {
    const refreshed = buildRunReceipt(this.inputs);
    if (stableJson(refreshed.inputs.textCandidates) !== stableJson(this.current.inputs.textCandidates)) {
      throw new Error(`Target ${phase} changed snapshotted candidate text; prepare text before starting a new run`);
    }
    if (stableJson(refreshed.inputs.collectorSources) !== stableJson(this.current.inputs.collectorSources)) {
      throw new Error(`Target ${phase} changed collector source artifacts; start a new run with the new artifacts`);
    }
    if (refreshed.evaluationFingerprint !== this.current.evaluationFingerprint) {
      throw new Error(`Target ${phase} changed evaluator specs or fixtures; target commands may modify target files only`);
    }
    if (
      priorEvidenceEligible &&
      stableJson(refreshed.target) !== stableJson(this.current.target)
    ) {
      throw new Error(
        `Target ${phase} changed the target revision while prior evidence was eligible for reuse. Start a new run instead of binding that evidence to a different target.`,
      );
    }
    this.receipt = refreshed;
    state.inputFingerprint = this.current.inputFingerprint;
    writeJson(path.join(this.runDir, "run-state.json"), state);
    writeJson(path.join(this.runDir, "receipt.json"), this.current);
  }
}
