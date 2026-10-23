import assert from "node:assert/strict";
import { chromium } from "playwright";
import { CUTS, FORMATS, exportName } from "./src/story.mjs";
const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url))
  throw new Error("Usage: node video/marketing/smoke.mjs http://HOST:PORT/video.html");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(url);
  for (const [cut, definition] of Object.entries(CUTS))
    for (const [format, dimensions] of Object.entries(FORMATS)) {
      await page.locator(`[data-cut=${cut}]`).click();
      await page.locator(`[data-format=${format}]`).click();
      await page.waitForFunction(() => document.querySelector("video").readyState >= 1);
      const metadata = await page
        .locator("video")
        .evaluate((video) => ({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          muted: video.muted,
        }));
      assert.deepEqual(metadata, { duration: definition.duration, ...dimensions, muted: true });
      const name = exportName(cut, format);
      assert.equal(
        await page.locator(".download").getAttribute("href"),
        `video-output/${name}.mp4`,
      );
      await page.waitForFunction(() => document.querySelectorAll("#transcript p").length > 0);
      assert.equal(await page.locator("#transcript p").count(), definition.scenes.length);
      await page.locator("video").evaluate(async (video) => {
        video.playbackRate = 8;
        await video.play();
      });
      await page.waitForFunction(() => document.querySelector("video").ended, null, {
        timeout: 30000,
      });
    }
  for (const width of [360, 540, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  for (const link of await page
    .locator(".proof a")
    .evaluateAll((links) => links.map((link) => link.href))) {
    const response = await page.request.get(link);
    assert.equal(response.ok(), true, link);
    if (link.endsWith(".html")) {
      const html = await response.text();
      for (const match of html.matchAll(/href="([^"#]+)"/g)) {
        const evidenceUrl = new URL(match[1], link).href;
        assert.equal((await page.request.get(evidenceUrl)).ok(), true, evidenceUrl);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "All six previews play to completion. Format/cut selection, downloads, transcripts, evidence links and responsive layouts pass. Accelerated playback verifies operation, not creative quality.",
  );
} finally {
  await browser.close();
}
