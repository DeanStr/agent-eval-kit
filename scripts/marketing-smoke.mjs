// Offline checks for the marketing demo. Requires Python 3 and Playwright Chromium.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const source = fileURLToPath(new URL("../docs/marketing/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "aek-marketing-"));
let browser;
try {
  const html = await readFile(join(source, "index.html"), "utf8");
  const svg = await readFile(join(source, "hill-climbing.svg"), "utf8");
  await writeFile(
    join(temporary, "build_visual.py"),
    await readFile(join(source, "build_visual.py")),
  );
  await writeFile(join(temporary, "index.html"), html);
  await writeFile(join(temporary, "hill-climbing.svg"), svg);
  function generate() {
    const result = spawnSync("python3", [join(temporary, "build_visual.py")], { encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  }
  const generated = generate();
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    await readFile(join(temporary, "index.html"), "utf8"),
    html,
    "embedded SVG is current",
  );
  assert.equal(await readFile(join(temporary, "hill-climbing.svg"), "utf8"), svg, "SVG is current");
  const start = "<!-- illustration:start -->";
  const end = "<!-- illustration:end -->";
  const invalidInputs = [
    html.replace(start, ""),
    html.replace(start, start + start),
    html.replace(start, "TEMPORARY_MARKER").replace(end, start).replace("TEMPORARY_MARKER", end),
  ];
  for (const invalid of invalidInputs) {
    await writeFile(join(temporary, "index.html"), invalid);
    await writeFile(join(temporary, "hill-climbing.svg"), "previous SVG");
    const result = generate();
    assert.notEqual(result.status, 0, "malformed insertion markers must fail");
    assert.match(result.stderr, /index\.html.*illustration:/);
    assert.equal(await readFile(join(temporary, "index.html"), "utf8"), invalid);
    assert.equal(await readFile(join(temporary, "hill-climbing.svg"), "utf8"), "previous SVG");
  }

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const externalRequests = [];
  await context.route(/^https?:/, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(source, "index.html")).href);
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const check = async (id, expected) => {
    assert.equal(await page.locator(`#${id}`).textContent(), expected, id);
  };
  const select = async (index) => {
    await page.getByRole("button", { name: `Revision 0${index}`, exact: true }).click();
  };

  await select(2);
  await check("score", "77");
  await check("best-score", "68");
  await page.locator("#play").click();
  await check("score", "…");
  await check("gates", "Pending");
  await check("best-score", "68");
  for (const index of [2, 3, 4, 5]) {
    const point = page.locator(`.point[data-step="${index}"]`);
    assert.equal(await point.locator(".evidence-card").getAttribute("aria-hidden"), "true");
    assert.match(await point.getAttribute("aria-label"), /pending|not evaluated/);
  }
  await page.clock.runFor(600);
  await page.locator("#play").click();
  await page.clock.runFor(5000);
  await check("decision", "PREPARING");
  await page.locator("#play").click();
  await page.clock.runFor(599);
  await check("decision", "PREPARING");
  await page.clock.runFor(1);
  await check("decision", "EVALUATING");
  await page.clock.runFor(1799);
  await check("score", "…");
  await page.clock.runFor(1);
  await check("score", "77");
  await check("gates", "Fail");
  await check("best-score", "68");
  assert.equal(
    await page.locator('.point[data-step="2"] .evidence-card').getAttribute("aria-hidden"),
    "false",
  );
  await page.clock.runFor(2000);
  await check("revision-label", "REVISION 03");
  await check("best-score", "68");
  await page.clock.runFor(3000);
  await check("score", "82");
  await check("best-score", "82");
  await page.clock.runFor(5000);
  await check("score", "—");
  await check("coverage", "58%");
  await check("best-score", "82");
  await page.clock.runFor(5000);
  await check("score", "91");
  await check("best-score", "91");
  await page.clock.runFor(2000);
  await check("play", "↻ Replay the climb");
  await page.locator("#play").click();
  await check("revision-label", "REVISION 00");
  await check("best-score", "—");
  await page.clock.runFor(30000);
  await check("play", "↻ Replay the climb");
  await check("score", "91");

  await select(0);
  await page.locator("#play").click();
  await page.clock.runFor(1200);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Reflect.deleteProperty(document, "hidden");
  });
  await check("play", "▶ Resume the climb");
  await page.clock.runFor(5000);
  await check("decision", "EVALUATING");
  await select(2);
  await page.clock.runFor(10000);
  await check("score", "77");
  await page.locator('.point[data-step="3"]').focus();
  await page.keyboard.press("Enter");
  await check("score", "82");
  await page.getByRole("button", { name: "Revision 03", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await check("score", "—");
  await page.keyboard.press("Home");
  await check("score", "54");
  await page.keyboard.press("End");
  await check("score", "91");

  for (const width of [320, 390, 760, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const index of [2, 4, 5]) {
      await select(index);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `no horizontal page overflow at ${width}px, revision ${index}`,
      );
    }
    if (width <= 760) {
      const rect = await page.locator(".chart").boundingBox();
      assert.ok(rect && rect.x >= -1 && rect.x + rect.width <= width + 1);
      assert.equal(
        await page.locator('.point[data-step="3"] .compact-label').evaluate((element) => {
          return getComputedStyle(element).display;
        }),
        "block",
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const clipped = await page.locator(".point").evaluateAll((points) => {
    return points.flatMap((point) => {
      const card = point.querySelector(".node-card").getBBox();
      return [...point.querySelectorAll(".evidence-card text")]
        .filter((text) => text.getBBox().x + text.getBBox().width > card.x + card.width)
        .map((text) => text.textContent);
    });
  });
  assert.deepEqual(clipped, [], "evidence labels fit their cards");
  assert.deepEqual(errors, [], "no browser errors");
  assert.deepEqual(externalRequests, [], "demo works without external assets or requests");
  console.log(
    "Marketing smoke passed: generation, invalid-input preservation, playback, accessibility, and responsive layout.",
  );
} finally {
  if (browser) await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
