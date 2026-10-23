import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const site = path.join(context.outputDir, "site");
fs.mkdirSync(site);
const files = {
  html: "index.html",
  css: "style.css",
  app: "app.js",
  data: "data.js",
  font: "InterVariable.woff2",
};
for (const [label, name] of Object.entries(files)) {
  if (!context.sources[label]) throw Error(`Missing source: ${label}`);
  fs.copyFileSync(context.sources[label].path, path.join(site, name));
}
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
};
const server = http.createServer((request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!Object.values(files).includes(name)) return response.writeHead(404).end();
  response
    .writeHead(200, { "content-type": mime[path.extname(name)] })
    .end(fs.readFileSync(path.join(site, name)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// In-page observation of the rendered state. Measurements, not verdicts.
const observe = () => {
  const clean = (text) => text.replace(/\s+/g, " ").trim();
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("")
      .trim();
  const shown = (el) =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const minFont = (el) =>
    Math.min(
      ...[el, ...el.querySelectorAll("*")]
        .filter((node) => ownText(node) && shown(node))
        .map((node) => parseFloat(getComputedStyle(node).fontSize)),
    );
  const trap = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (
        ["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(a).overflowY) &&
        a.scrollHeight > a.clientHeight + 1
      )
        return { visibleHeight: a.clientHeight, contentHeight: a.scrollHeight };
    }
    return null;
  };
  const summary = document.querySelector('[aria-label="Dispatch summary"]'),
    drivers = document.querySelector("#driver-list"),
    detail = document.querySelector("#detail");
  if (!summary || !drivers || !detail)
    throw Error("Page contract missing the Dispatch summary, #driver-list or #detail");
  const detailTimes = [...detail.querySelectorAll("*")].filter(
    (node) => /^\d{2}:\d{2}$/.test(ownText(node)) && shown(node),
  );
  return {
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    rows: [...document.querySelectorAll("[data-shipment]")].map((row) => ({
      id: row.dataset.shipment,
      text: clean(row.innerText),
      minFont: minFont(row),
      trappedIn: trap(row),
    })),
    summary: clean(summary.innerText),
    drivers: clean(drivers.innerText),
    detail: clean(detail.innerText),
    detailTimeFonts: detailTimes.map((node) => parseFloat(getComputedStyle(node).fontSize)),
  };
};
const dialogState = () => {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return { open: false };
  const r = dialog.getBoundingClientRect();
  return {
    open: true,
    rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    text: dialog.innerText.replace(/\s+/g, " ").trim(),
    options: [...dialog.querySelectorAll('input[type="radio"]')].map((input) => {
      const label = input.closest("label") ?? input.parentElement;
      const fonts = [label, ...label.querySelectorAll("*")]
        .filter(
          (node) =>
            [...node.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) &&
            node.getClientRects().length,
        )
        .map((node) => parseFloat(getComputedStyle(node).fontSize));
      return {
        text: label.innerText.replace(/\s+/g, " ").trim(),
        disabled: input.disabled,
        checked: input.checked,
        minFont: Math.min(...fonts),
      };
    }),
  };
};
const focused = () => {
  const el = document.activeElement;
  return {
    text: (el?.innerText ?? "").trim(),
    insideDetail: Boolean(el?.closest("#detail")),
  };
};
const height = (locator) => locator.evaluate((el) => el.getBoundingClientRect().height);
const inViewport = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  });

const browser = await chromium.launch();
const observations = {};
const images = [];
const shot = async (page, label, extraction) => {
  await page.screenshot({ path: path.join(context.outputDir, `${label}.png`), animations: "disabled" });
  images.push({ label, path: `${label}.png`, source: "html", extraction });
};
try {
  for (const [size, viewport] of Object.entries({
    desktop: { width: 1440, height: 1000 },
    phone: { width: 390, height: 844 },
  })) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) =>
      route.request().url().startsWith(url)
        ? route.continue()
        : (errors.push(`Unexpected external resource: ${route.request().url()}`), route.abort()),
    );
    const states = {},
      steps = [];
    const step = async (name, action) => {
      try {
        const detail = await action();
        steps.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
      } catch (error) {
        steps.push({ name, ok: false, error: error.message.split("\n")[0] });
      }
    };
    const rowCount = () => page.locator("[data-shipment]").count();
    const detail = page.locator("#detail");
    const trigger = detail.getByRole("button", { name: /^reassign/i });
    const dialog = page.locator("dialog[open]");
    const confirm = dialog.getByRole("button", { name: /reassign to|confirm/i });
    const settle = () => page.waitForTimeout(700); // allow smooth scrolling to finish

    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    states.initial = await page.evaluate(observe);
    await shot(
      page,
      size,
      `Actual ${viewport.width} × ${viewport.height} Chromium viewport on first load; no styling injected.`,
    );
    for (const [name, pattern] of [
      ["filterAtRisk", /^At risk\b/],
      ["filterCompleted", /^Completed\b/],
      ["filterAll", /^All deliveries\b/],
    ])
      await step(name, async () => {
        await page.getByRole("button", { name: pattern }).click();
        return { rows: await rowCount() };
      });
    await step("emptySearch", async () => {
      await page.getByRole("searchbox").fill("No such delivery");
      const rows = await rowCount();
      await page.getByRole("button", { name: /show all|clear/i }).click();
      return {
        rows,
        restoredRows: await rowCount(),
        search: await page.getByRole("searchbox").inputValue(),
      };
    });
    await step("onTimeShipment", async () => {
      await page.getByRole("searchbox").fill("Studio August");
      await page.locator('[data-shipment="RL-2053"]').click();
      const result = {
        detail: (await detail.innerText()).replace(/\s+/g, " ").trim(),
        reassignControls: await trigger.count(),
      };
      await page.getByRole("searchbox").fill("");
      return result;
    });
    await step("selectLateShipment", async () => {
      await page.locator('[data-shipment="RL-2048"]').click();
      await settle();
      const heading = detail.locator(":is(h1, h2, h3)").first();
      return {
        detailInView: await heading.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        }),
      };
    });
    states.selected = await page.evaluate(observe);
    if (size === "phone")
      await shot(
        page,
        "phone-detail",
        "Actual 390 × 844 Chromium viewport after selecting RL-2048 in the queue.",
      );
    await step("openDialog", async () => {
      const triggerHeight = await height(trigger);
      await trigger.click();
      await dialog.waitFor();
      await confirm.scrollIntoViewIfNeeded();
      return {
        triggerHeight,
        dialog: await page.evaluate(dialogState),
        confirmHeight: await height(confirm),
        confirmInView: await inViewport(confirm),
      };
    });
    await page.evaluate(() => document.querySelector("dialog[open]")?.scrollTo(0, 0));
    await shot(
      page,
      `${size}-dialog`,
      `Actual ${viewport.width} × ${viewport.height} Chromium viewport with the recovery dialog open.`,
    );
    await step("escapeCloses", async () => {
      await page.keyboard.press("Escape");
      return { open: (await page.evaluate(dialogState)).open, focus: await page.evaluate(focused) };
    });
    await step("enterReopens", async () => {
      await trigger.focus();
      await page.keyboard.press("Enter");
      return { open: (await page.evaluate(dialogState)).open };
    });
    await step("confirmLeo", async () => {
      await dialog.getByRole("radio", { name: /Leo/ }).check();
      await confirm.click();
      await settle();
      return { open: (await page.evaluate(dialogState)).open };
    });
    states.assigned = await page.evaluate(observe);
    await step("undoControl", async () => ({
      height: await height(detail.getByRole("button", { name: /^undo/i })),
    }));
    if (size === "desktop")
      await shot(
        page,
        "desktop-after",
        "Actual 1440 × 1000 Chromium viewport immediately after confirming the reassignment.",
      );
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    states.assignedReload = await page.evaluate(observe);
    await step("undo", async () => {
      await detail.getByRole("button", { name: /^undo/i }).click();
    });
    states.undone = await page.evaluate(observe);
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    states.undoneReload = await page.evaluate(observe);
    await step("resetCancel", async () => {
      await trigger.click();
      await confirm.click();
      await page.getByRole("button", { name: /^Reset demo/ }).click();
      await dialog.getByRole("button", { name: /keep|cancel/i }).first().click();
      return { summary: (await page.evaluate(observe)).summary };
    });
    await step("resetConfirm", async () => {
      await page.getByRole("button", { name: /^Reset demo/ }).click();
      await dialog.getByRole("button", { name: /^Reset demo/ }).click();
    });
    states.reset = await page.evaluate(observe);
    observations[size] = { states, steps, errors };
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
fs.writeFileSync(path.join(context.outputDir, "observations.json"), JSON.stringify(observations, null, 2));
const failed = (size) => observations[size].steps.filter((s) => !s.ok).map((s) => s.name);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary:
      "Served the snapshotted dispatch prototype locally and completed the recovery task at 1440px and 390px, including cancel, reload, undo and reset.",
    observations: [
      `Desktop first-load summary: ${observations.desktop.states.initial.summary}. Selected details: ${observations.desktop.states.initial.detail}`,
      `Desktop recovery dialog: ${observations.desktop.steps.find((s) => s.name === "openDialog")?.detail?.dialog?.text ?? "did not open"}`,
      `Desktop after confirming: ${observations.desktop.states.assigned.summary}. ${observations.desktop.states.assigned.detail}`,
      `Phone first-load summary: ${observations.phone.states.initial.summary}; page width ${observations.phone.states.initial.scrollWidth}px in a ${observations.phone.states.initial.width}px viewport.`,
      `Interaction steps that could not be completed: desktop ${failed("desktop").join(", ") || "none"}; phone ${failed("phone").join(", ") || "none"}.`,
    ],
    files: [
      {
        label: "observations",
        path: "observations.json",
        filename: "observations.json",
        mediaType: "application/json",
      },
    ],
    images,
  }),
);
