import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import YAML from "yaml";

const kitRoot = path.resolve(import.meta.dirname, "..");

for (const phase of ["setup", "readiness", "grading", "campaign"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} during ${phase} stops children and releases the run lock`, { skip: process.platform === "win32", timeout: 20_000 }, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-cancel-"));
      const runs = path.join(root, "runs");
      fs.mkdirSync(runs);
      fs.writeFileSync(path.join(root, "wait.cjs"), `const fs=require('node:fs'); fs.writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
      const command = (name: string) => `${JSON.stringify(process.execPath)} wait.cjs runs/${name}.pid`;
      fs.writeFileSync(path.join(root, "evalkit.yaml"), YAML.stringify({
        version: 1, project: { name: "Cancellation", root: "." },
        target: {
          kind: "repository",
          ...(phase === "setup" ? { setup: command("setup") } : {
            start: command("target"),
            ready: { command: phase === "readiness" ? command("ready") : "test -f runs/target.pid", timeoutSeconds: 60, intervalMs: 10 },
          }),
        },
        agent: { provider: "mock" }, judge: { provider: "mock" },
        paths: { specs: "spec.yaml", runs: "runs" },
      }));
      fs.writeFileSync(path.join(root, "spec.yaml"), YAML.stringify({
        id: "core", title: "Core", description: "Cancellation fixture", weight: 100,
        scenarios: [{ id: "S1", name: "Inspect", instructions: "Inspect" }],
        rubric: [{ id: "R1", criterion: "Wait", weight: 1, passCriteria: "Returns", grader: { type: "command", methodFiles: [], output: "exit-code", command: command("grader") } }],
      }));
      const campaignDir = path.join(root, "campaign");
      const args = phase === "campaign" ? ["campaign", "--repetitions", "3", "--output", campaignDir] : ["run"];
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(kitRoot, "src/cli.ts"), ...args], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve(code));
      });
      try {
        const marker = path.join(runs, `${phase === "setup" ? "setup" : phase === "readiness" ? "ready" : "grader"}.pid`);
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(20);
        assert.ok(fs.existsSync(marker), output);
        child.kill(signal);
        assert.equal(await exited, signal === "SIGINT" ? 130 : 143, output);
        for (const file of fs.readdirSync(runs).filter(file => file.endsWith(".pid"))) {
          const pid = Number(fs.readFileSync(path.join(runs, file), "utf8"));
          assert.throws(() => process.kill(pid, 0), /ESRCH/, `${file} is still alive`);
        }
        const directories = fs.readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory());
        assert.equal(directories.length, 1, "cancellation must not start another repetition");
        const run = path.join(runs, directories[0].name);
        assert.equal(JSON.parse(fs.readFileSync(path.join(run, "run-state.json"), "utf8")).status, "failed");
        assert.equal(fs.existsSync(path.join(run, ".run.lock")), false);
        if (phase === "campaign") {
          const campaign = JSON.parse(fs.readFileSync(path.join(campaignDir, "campaign.json"), "utf8"));
          assert.equal(campaign.runs.length, 1);
          assert.equal(campaign.coverage.failedRuns, 1);
          assert.equal(campaign.coverage.pendingRuns, 2);
        }
      } finally {
        child.kill("SIGKILL");
        for (const file of fs.readdirSync(runs).filter(file => file.endsWith(".pid"))) {
          try { process.kill(Number(fs.readFileSync(path.join(runs, file), "utf8")), "SIGKILL"); } catch { /* already stopped */ }
        }
        await exited;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
