import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const target = path.join(context.outputDir, "dashboard.html");
fs.copyFileSync(context.sources.page.path, target);
const browser = await chromium.launch();
const observations = {};
const images = [];
try {
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1280, height: 800 },
    mobile: { width: 375, height: 812 },
  })) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) => {
      errors.push(`Unexpected external resource: ${route.request().url()}`);
      return route.abort();
    });
    await page.goto(pathToFileURL(target).href);
    const inspect = () =>
      page.evaluate(() => {
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            fontSize: parseFloat(getComputedStyle(el).fontSize),
            visible:
              getComputedStyle(el).visibility === "visible" &&
              getComputedStyle(el).display !== "none",
          };
        };
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          text: document.body.innerText,
          rows: [...document.querySelectorAll(".row")].map((row) => {
            const label = row.querySelector(".label"),
              value = row.querySelector(".value"),
              bar = row.querySelector(".bar");
            if (!label || !value || !bar)
              throw Error("Dashboard row contract missing label/value/bar");
            return {
              label: label.textContent.trim(),
              value: Number(value.textContent.trim()),
              labelRect: rect(label),
              valueRect: rect(value),
              barRect: rect(bar),
            };
          }),
        };
      });
    await page.evaluate(() => window.__AEK_EVAL__.reset());
    observations[`${name}Weekly`] = await inspect();
    await page.screenshot({
      path: path.join(context.outputDir, `${name}.png`),
      animations: "disabled",
    });
    images.push({
      label: name,
      path: `${name}.png`,
      source: "page",
      extraction: `Actual ${viewport.width} × ${viewport.height} browser screenshot of sealed HTML after reset; no styling injected.`,
    });
    await page.evaluate(() => window.__AEK_EVAL__.configure({ dataset: "monthly" }));
    observations[`${name}Monthly`] = await inspect();
    await page.evaluate(() => {
      window.__AEK_EVAL__.reset();
      window.__AEK_EVAL__.advance(1);
    });
    observations[`${name}Advanced`] = await inspect();
    await page.evaluate(() => window.__AEK_EVAL__.reset());
    observations[`${name}Reset`] = await inspect();
    if (errors.length) throw Error(errors.join("\n"));
    await page.close();
  }
  fs.writeFileSync(
    path.join(context.outputDir, "observations.json"),
    JSON.stringify(observations, null, 2),
  );
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "completed",
      summary:
        "Captured the existing dashboard on desktop and phone; exercised both datasets, advance and reset.",
      observations: [
        `Desktop weekly visible text: ${observations.desktopWeekly.text}`,
        `Phone weekly scroll width: ${observations.mobileWeekly.scrollWidth}; viewport: ${observations.mobileWeekly.width}.`,
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
} finally {
  await browser.close();
}
