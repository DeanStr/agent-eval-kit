import { spawn } from "node:child_process";

export function windowsTaskkillArguments(pid: number, force: boolean): string[] {
  return ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
}

export async function terminateWindowsTree(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill", windowsTaskkillArguments(pid, force), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stderr = "";
    killer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    killer.once("error", (error) => finish(error));
    killer.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(
        `taskkill failed for process tree ${pid}${signal ? ` with signal ${signal}` : ` with exit ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}
