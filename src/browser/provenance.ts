import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/** Use Playwright's launch selection: executablePath() always names full Chromium. */
export function chromiumVersion(headless: boolean): string {
  const require = createRequire(import.meta.url);
  const probe = `
    const { chromium } = require(process.argv[1]);
    (async () => {
      const browser = await chromium.launch({ headless: JSON.parse(process.argv[2]), timeout: 20000 });
      try { process.stdout.write(browser.version()); }
      finally { await browser.close(); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  // Receipts are synchronous; isolate the browser launch in a bounded subprocess.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      probe,
      require.resolve("playwright"),
      JSON.stringify(headless),
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: process.env,
    },
  );
  const version = result.stdout?.trim();
  if (result.error || result.status !== 0 || !version) {
    const detail =
      result.error?.message || result.stderr?.trim() || `probe exited with status ${result.status}`;
    throw new Error(
      `Unable to determine Chromium version for ${headless ? "headless" : "headed"} capture. Check the browser installation and launch environment (pnpm exec playwright install chromium). ${detail}`,
    );
  }
  return version;
}
