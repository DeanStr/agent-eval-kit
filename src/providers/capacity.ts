import fs from "node:fs";
import path from "node:path";
import { cancellableDelay, throwIfCancelled } from "../cancellation.js";
import { writeJson } from "../io.js";
import type { ProviderInvocation, ProviderResult } from "../types.js";

// Deliberately exclude authentication, billing/quota, timeouts, generic rate
// limits and malformed output. Only explicit temporary capacity signals qualify.
const capacity =
  /\b(?:insufficient_capacity|model_capacity_exceeded|overloaded_error|server_overloaded)\b|\b(?:model|server|service)\b[^\n]{0,80}\b(?:at capacity|overloaded)\b|\b(?:insufficient|no available) (?:model |server )?capacity\b/i;

export function isCapacityFailure(result: ProviderResult, invocation: ProviderInvocation): boolean {
  const output = result.structured;
  const errorEnvelope =
    output != null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "error" in output &&
    Object.keys(output).every((key) =>
      ["error", "type", "code", "status", "message", "is_error"].includes(key),
    );
  const malformedAnswer =
    output === undefined &&
    result.finalText.trim().length > 0 &&
    result.finalTextSource !== "error";
  if (
    result.exitCode === 0 ||
    result.timedOut ||
    result.signal ||
    result.policyViolations?.length ||
    result.responseEmitted ||
    (output !== undefined && !errorEnvelope) ||
    malformedAnswer
  )
    return false;
  const diagnostics: string[] = errorEnvelope ? [JSON.stringify(output)] : [];
  if (result.finalTextSource === "error") diagnostics.push(result.finalText);
  if (fs.existsSync(invocation.stderrFile))
    diagnostics.push(fs.readFileSync(invocation.stderrFile, "utf8"));
  if (fs.existsSync(invocation.eventLogFile)) {
    for (const line of fs.readFileSync(invocation.eventLogFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (
          ["error", "turn.failed", "thread.error"].includes(event.type) ||
          (event.type === "result" && event.is_error === true)
        )
          diagnostics.push(JSON.stringify(event.error ?? event));
      } catch {
        /* The adapter owns malformed-event errors; never retry them. */
      }
    }
  }
  if (
    diagnostics.some((text) =>
      /\b(?:unauthorized|authentication|billing|quota)\b|usage limit|rate[ _-]limit/i.test(text),
    )
  )
    return false;
  return diagnostics.some((text) => capacity.test(text));
}

export async function withCapacityRetries(
  invocation: ProviderInvocation,
  run: () => Promise<ProviderResult>,
): Promise<ProviderResult> {
  const retries = invocation.capacityRetries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5)
    throw new Error("capacityRetries must be an integer from 0 to 5");
  if (!retries || invocation.purpose !== "judge") return run();
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled();
    const result = await run();
    if (attempt >= retries || !isCapacityFailure(result, invocation)) return result;
    // Retain failed invocations before reusing the fixed prompt and image order.
    const root = path.join(path.dirname(invocation.outputFile), "capacity-retries");
    fs.mkdirSync(root, { recursive: true });
    let ordinal = 1;
    while (fs.existsSync(path.join(root, `attempt-${ordinal}`))) ordinal++;
    const archive = path.join(root, `attempt-${ordinal}`);
    fs.mkdirSync(archive);
    const delayMs = Math.min(30_000, 1000 * 2 ** attempt);
    writeJson(path.join(archive, "provider-run.json"), { ...result, retryDelayMs: delayMs });
    for (const file of [
      invocation.outputFile,
      invocation.eventLogFile,
      invocation.stderrFile,
      path.join(path.dirname(invocation.outputFile), "evidence-transcript.ndjson"),
    ]) {
      if (fs.existsSync(file)) fs.renameSync(file, path.join(archive, path.basename(file)));
    }
    invocation.onProgress?.(
      `Temporary provider capacity error; retry ${attempt + 1}/${retries} in ${delayMs}ms`,
    );
    await cancellableDelay(delayMs);
  }
}
