import fs from "node:fs";
import path from "node:path";

export class RunLogger {
  private readonly stream: fs.WriteStream;

  constructor(
    file: string,
    private readonly onProgress: (message: string) => void = console.log,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { flags: "a" });
  }

  line(message: string): void {
    const value = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
    this.onProgress(value);
    this.stream.write(`${value}\n`);
  }

  async close(): Promise<void> {
    if (this.stream.closed) return;
    await new Promise<void>((resolve) => {
      this.stream.once("close", resolve);
      this.stream.end();
    });
  }
}
