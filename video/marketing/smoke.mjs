import assert from "node:assert/strict";
import { chromium } from "playwright";
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
  for (const [format, width, height] of [
    ["landscape", 1920, 1080],
    ["portrait", 1080, 1350],
  ]) {
    await page.locator(`[data-format=${format}]`).click();
    await page.waitForFunction((id) => document.getElementById(id).readyState >= 1, format);
    const metadata = await page
      .locator(`#${format}`)
      .evaluate((video) => ({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        muted: video.muted,
        visible: !video.hidden,
      }));
    assert.deepEqual(metadata, { duration: 40, width, height, muted: true, visible: true });
    assert.equal(
      await page.locator(".download").getAttribute("href"),
      `video-output/${format}.mp4`,
    );
    await page.locator(`#${format}`).evaluate(async (video) => {
      video.playbackRate = 8;
      await video.play();
    });
    await page.waitForFunction((id) => document.getElementById(id).ended, format, {
      timeout: 20000,
    });
  }
  for (const width of [360, 540, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No horizontal overflow at ${width}px`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Both preview formats play to completion, downloads select the right file, and layouts fit 360–1200px. Accelerated playback checks operation, not motion quality.",
  );
} finally {
  await browser.close();
}
