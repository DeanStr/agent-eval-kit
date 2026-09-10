import type { ProviderId, ProviderInvocation, ProviderResult } from "../types.js";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runCursor } from "./cursor.js";
import { runGrok } from "./grok.js";
import { runMock } from "./mock.js";

export async function runProvider(
  provider: ProviderId,
  invocation: ProviderInvocation,
): Promise<ProviderResult> {
  switch (provider) {
    case "codex":
      return runCodex(invocation);
    case "claude":
      return runClaude(invocation);
    case "grok":
      return runGrok(invocation);
    case "cursor":
      return runCursor(invocation);
    case "mock":
      return runMock(invocation);
  }
}
