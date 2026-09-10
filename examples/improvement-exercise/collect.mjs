import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const browser = await chromium.launch();
try {
  const session = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const unexpectedRequests = [];
  await session.route(/^https?:/, async (route) => {
    unexpectedRequests.push(route.request().url());
    await route.abort();
  });
  const page = await session.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Snapshot paths are content-addressed and have no extension. Chromium needs
  // an HTML filename to execute these exact bytes rather than display text.
  const renderedPage = path.join(context.outputDir, "render.html");
  fs.copyFileSync(context.sources.page.path, renderedPage);
  await page.goto(pathToFileURL(renderedPage).href);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  const states = {};
  const capture = async (name) => {
    states[name] = await page.evaluate(() =>
      Object.fromEntries(
        [
          "revision-label",
          "decision",
          "score",
          "coverage",
          "gates",
          "best-score",
          "finding",
          "action",
        ].map((id) => {
          const element = document.getElementById(id);
          if (!element) throw new Error(`Missing required evidence element: ${id}`);
          return [id, element.textContent.trim()];
        }),
      ),
    );
  };
  const select = (index) =>
    page.getByRole("button", { name: `Revision 0${index}`, exact: true }).click();
  await select(2);
  await capture("rejected");
  await select(4);
  await capture("unverified");
  await page
    .locator(".inspector")
    .screenshot({ path: path.join(context.outputDir, "unverified.png"), animations: "disabled" });
  await select(2);
  await page.locator("#play").click();
  await capture("preparing");
  await page.clock.runFor(600);
  await page.locator("#play").click();
  await page.clock.runFor(5000);
  await capture("paused");
  await page.locator("#play").click();
  await page.clock.runFor(600);
  await capture("evaluating");
  await page.clock.runFor(1800);
  await capture("finished");
  if (errors.length || unexpectedRequests.length) {
    throw new Error(`Capture failed: ${JSON.stringify({ errors, unexpectedRequests })}`);
  }
  fs.writeFileSync(path.join(context.outputDir, "states.json"), JSON.stringify(states, null, 2));
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "completed",
      summary:
        "Exercised revision selection and timed pause/resume in the snapshotted marketing page.",
      observations: Object.entries(states).map(
        ([name, state]) => `${name}: ${JSON.stringify(state)}`,
      ),
      files: [
        {
          label: "states",
          path: "states.json",
          filename: "states.json",
          mediaType: "application/json",
        },
      ],
      images: [
        {
          label: "unverified",
          path: "unverified.png",
          source: "page",
          extraction:
            "Playwright screenshot of the visible inspector after selecting Revision 04; target JavaScript executed from the sealed HTML source. Browser clock controlled for repeatability.",
        },
      ],
    }),
  );
} finally {
  await browser.close();
}
