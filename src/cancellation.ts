import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Scope cancellation to one invocation, including its provider and lifecycle
// descendants, without installing process-wide handlers in library callers.
const scope = new AsyncLocalStorage<AbortSignal>();

export function withCancellation<T>(signal: AbortSignal, action: () => T): T {
  return scope.run(signal, action);
}

export function cancellationSignal(): AbortSignal | undefined {
  return scope.getStore();
}

export function throwIfCancelled(): void {
  cancellationSignal()?.throwIfAborted();
}

export async function cancellableDelay(milliseconds: number): Promise<void> {
  await delay(milliseconds, undefined, { signal: cancellationSignal() });
}

export async function withCliSignals(action: () => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    if (controller.signal.aborted) return;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    console.error(`Received ${signal}; stopping active evaluation processes…`);
    controller.abort(new Error(`Evaluation interrupted by ${signal}`));
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await withCancellation(controller.signal, action);
    controller.signal.throwIfAborted();
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
