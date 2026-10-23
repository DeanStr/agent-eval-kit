import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, late, load, reassign } from "../../../docs/marketing/dispatch/data.js";

const base = process.argv[2];
if (!base)
  throw new Error(
    "Usage: node video/marketing/improvement/prototype-check.mjs <marketing-preview-base-url>",
  );
const output = path.resolve(".agent-eval/marketing-video/dispatch-review");
fs.mkdirSync(output, { recursive: true });
const url = new URL("dispatch/", base.endsWith("/") ? base : `${base}/`).href;
const results = [];

// Independent task invariants: a recovery must preserve unrelated work and obey constraints.
const moved = reassign(fixture.shipments, "RL-2048", "leo");
assert.deepEqual(
  moved.map((s) => s.id),
  fixture.shipments.map((s) => s.id),
);
assert.deepEqual(
  moved.filter((s) => s.id !== "RL-2048"),
  fixture.shipments.filter((s) => s.id !== "RL-2048"),
);
assert.equal(moved.filter(late).length, 0);
assert.equal(load(moved, "leo"), 4);
assert.equal(load(moved, "maya"), 1);
assert.throws(() => reassign(fixture.shipments, "RL-2048", "nina"), /temperature-controlled/);
const fullVan = fixture.shipments.map((s) => (s.id === "RL-2049" ? { ...s, units: 4 } : s));
assert.throws(() => reassign(fullVan, "RL-2048", "leo"), /capacity/);
assert.throws(() => reassign(fixture.shipments, "RL-2045", "maya"), /active shipment/);
assert.throws(() => reassign(fixture.shipments, "RL-2051", "leo"), /only available/);
results.push({
  check: "Shipment preservation, load limits, cold-chain and unsupported-route rejection",
  pass: true,
});

const browser = await chromium.launch();
try {
  for (const width of [360, 390, 768, 1024, 1280, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: width > 700 ? 1000 : 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check("14px Inter")), true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `${width}: overflow`,
    );
    assert.equal(await page.locator(".delivery").count(), 9);
    assert.equal(await page.locator("#risk-count").textContent(), "1");
    if ([390, 1440].includes(width))
      await page.screenshot({ path: path.join(output, `final-${width}.png`), fullPage: true });

    await page.getByRole("button", { name: /At risk/ }).click();
    assert.equal(await page.locator(".delivery").count(), 1);
    await page.getByRole("button", { name: /Reassign delivery/ }).click();
    assert.equal(await page.getByRole("radio", { name: /Nina Patel/ }).isDisabled(), true);
    assert.match(
      await page.locator("#recovery").textContent(),
      /No temperature-controlled vehicle/,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#recovery").evaluate((el) => el.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "find-recovery");
    await page.getByRole("button", { name: /Reassign delivery/ }).press("Enter");
    if ([390, 1440].includes(width))
      await page.screenshot({ path: path.join(output, `recovery-${width}.png`) });
    await page.getByRole("button", { name: /Reassign to Leo/ }).click();
    assert.equal(await page.locator("#risk-count").textContent(), "0");
    assert.match(await page.locator("#detail").textContent(), /14:18/);
    assert.match(await page.locator("#detail").textContent(), /Leo Chen/);
    assert.match(await page.locator("#shipments").textContent(), /No deliveries at risk/);
    await page.reload();
    assert.equal(await page.locator("#risk-count").textContent(), "0");
    assert.equal(await page.locator(".delivery").count(), 9);
    assert.match(await page.locator('[data-shipment="RL-2053"]').textContent(), /14:35/);
    assert.match(await page.locator("#driver-list").textContent(), /4 \/ 5 units/);
    if ([390, 1440].includes(width))
      await page.screenshot({ path: path.join(output, `recovered-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Undo reassignment" }).click();
    assert.equal(await page.locator("#risk-count").textContent(), "1");
    await page.reload();
    assert.match(await page.locator("#detail").textContent(), /Maya Wilson/);
    assert.match(await page.locator("#detail").textContent(), /14:52/);

    await page.getByRole("searchbox").fill("No such delivery");
    assert.equal(await page.locator(".delivery").count(), 0);
    assert.match(await page.locator("#shipments").textContent(), /No deliveries found/);
    await page.getByRole("button", { name: "Show all deliveries" }).click();
    await page.getByRole("searchbox").fill("Studio August");
    assert.equal(await page.locator(".delivery").count(), 1);
    await page.locator(".delivery").click();
    assert.equal(await page.locator("#selected-title").textContent(), "Studio August");
    assert.equal(await page.locator("#find-recovery").count(), 0);
    await page.getByRole("searchbox").fill("");
    await page.getByRole("button", { name: /Completed 3/ }).click();
    assert.equal(await page.locator(".delivery").count(), 3);
    await page.getByRole("button", { name: /Reset demo/ }).click();
    await page.getByRole("button", { name: "Keep my changes" }).click();
    assert.equal(await page.locator(".delivery").count(), 3);
    await page.getByRole("button", { name: /Reset demo/ }).click();
    await page.locator("#confirm-reset").click();
    assert.equal(await page.locator(".delivery").count(), 9);
    assert.equal(await page.locator("#selected-title").textContent(), "Riverton Medical");
    assert.deepEqual(errors, []);
    results.push({
      check: `${width}px: full keyboard/modal/recovery/persistence/undo/filter/search/reset flow`,
      pass: true,
    });
    await context.close();
  }

  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(() => localStorage.setItem("aek-relay-prototype-v1", "invalid-json"));
  await page.reload();
  assert.equal(await page.getByRole("heading", { name: "This demo could not load." }).count(), 1);
  await page.getByRole("button", { name: "Clear saved demo and reload" }).click();
  await page.locator("#find-recovery").waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  await page.getByRole("button", { name: /Reassign delivery/ }).click();
  await page.getByRole("button", { name: /Reassign to Leo/ }).click();
  assert.equal(await page.locator("#recovery").evaluate((el) => el.open), true);
  assert.match(
    await page.locator("#recovery-error").textContent(),
    /Storage unavailable.*assignment has not changed/,
  );
  assert.equal(await page.locator("#risk-count").textContent(), "1");
  results.push({
    check: "Corrupt saved state fails visibly; unavailable storage cannot fabricate success",
    pass: true,
  });
  await page.close();

  const review = await browser.newPage();
  await review.goto(new URL("../example.html", url).href);
  await review.getByRole("button", { name: "Baseline prototype" }).click();
  assert.match(await review.locator("iframe").getAttribute("src"), /prototype-baseline\/$/);
  assert.equal(
    (
      await review.request.get(
        new URL(await review.locator("#open").getAttribute("href"), review.url()).href,
      )
    ).status(),
    200,
  );
  await review.getByRole("button", { name: "Current design" }).click();
  assert.equal(await review.locator("iframe").getAttribute("src"), "dispatch/");
  results.push({ check: "Creative review links and endpoint switch", pass: true });
} finally {
  await browser.close();
}
fs.writeFileSync(
  path.join(output, "checks.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      url,
      results,
      scope: "Functional prototype checks, not AEK evaluation results or audience approval.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
