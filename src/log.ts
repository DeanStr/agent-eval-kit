import fs from "node:fs";
import path from "node:path";
import { formatDuration } from "./format.js";
import type { Tone } from "./terminal.js";

export type ProgressSink = (message: string, tone?: Tone) => void;

/** How long a step may run silently before the terminal hears that it is still alive. */
export const HEARTBEAT_MS = 30_000;

export class RunLogger {
  private readonly stream: fs.WriteStream;
  private readonly heartbeat: NodeJS.Timeout;
  private activityStartedAt = Date.now();
  private lastOutputAt = Date.now();
  private indent = "";

  constructor(
    file: string,
    private readonly onProgress: ProgressSink = (message) => console.log(message),
    heartbeatMs = HEARTBEAT_MS,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { flags: "a" });
    // Provider and judge calls can be silent for minutes. The heartbeat goes to
    // the terminal only; run.log keeps the substantive progress lines.
    this.heartbeat = setInterval(
      () => {
        const now = Date.now();
        if (now - this.lastOutputAt < heartbeatMs) return;
        this.lastOutputAt = now;
        this.onProgress(
          `${this.timestamp()} ${this.indent}… still working (${formatDuration(now - this.activityStartedAt)})`,
          "muted",
        );
      },
      Math.min(heartbeatMs, 5_000),
    );
    this.heartbeat.unref();
  }

  private timestamp(): string {
    return `[${new Date().toISOString().slice(11, 19)}]`;
  }

  line(message: string, tone?: Tone): void {
    const value = `${this.timestamp()} ${message}`;
    this.activityStartedAt = this.lastOutputAt = Date.now();
    this.indent = /^\s*/.exec(message)?.[0] ?? "";
    this.onProgress(value, tone);
    this.stream.write(`${value}\n`);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    if (this.stream.closed) return;
    await new Promise<void>((resolve) => {
      this.stream.once("close", resolve);
      this.stream.end();
    });
  }
}
