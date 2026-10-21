import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
if (!["browser", "file"].includes(process.argv[2]))
  throw new Error("Collector requires browser or file");
const scope = fs.readFileSync(context.sources.scope.path, "utf8").trim();
if (!["available", "withheld"].includes(scope)) throw new Error(`Unknown evidence scope: ${scope}`);
if (scope === "withheld") {
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "blocked",
      summary: "The requested runtime observation is unavailable in this evidence package.",
      observations: ["The runtime behavior was not observed; source bytes do not establish it."],
    }),
  );
} else if (process.argv[2] === "browser") {
  // The preparer writes an explicit import URL for the installed Playwright dependency.
  const { chromium } = await import(JSON.parse(fs.readFileSync("browser-module.json", "utf8")));
  const browser = await chromium.launch();
  try {
    const session = await browser.newContext({ viewport: { width: 900, height: 600 } });
    await session.route(/^https?:/, (route) => route.abort());
    const page = await session.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const rendered = path.join(context.outputDir, "subject.html");
    fs.copyFileSync(context.sources.subject.path, rendered);
    await page.goto(pathToFileURL(rendered).href);
    await page.locator("#quantity").fill("2");
    await page.locator("#quantity").dispatchEvent("change");
    const read = () =>
      page.evaluate(() => ({
        quantity: document.querySelector("#quantity").value,
        subtotal: document.querySelector("#subtotal").textContent,
      }));
    const before = await read();
    await page.screenshot({ path: path.join(context.outputDir, "before.png") });
    await page.reload();
    const after = await read();
    await page.screenshot({ path: path.join(context.outputDir, "after.png") });
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    console.log(
      JSON.stringify({
        version: 1,
        outcome: "completed",
        summary: "Changed quantity, captured the page, reloaded, and captured the resulting state.",
        observations: [
          `Before reload: ${JSON.stringify(before)}`,
          `After reload: ${JSON.stringify(after)}`,
        ],
        images: ["before", "after"].map((label) => ({
          label,
          path: `${label}.png`,
          source: "subject",
          extraction: `Playwright viewport screenshot ${label} an actual reload of the snapshotted page.`,
        })),
      }),
    );
  } finally {
    await browser.close();
  }
} else if (process.argv[2] === "file") {
  const executable = path.join(context.outputDir, "exporter.mjs");
  fs.copyFileSync(context.sources.subject.path, executable);
  const { exportInvoice } = await import(pathToFileURL(executable).href);
  const invoice = exportInvoice([{ description: "Notebook", quantity: 2, priceCents: 1250 }]);
  const contents = JSON.stringify(invoice, null, 2) + "\n";
  fs.writeFileSync(path.join(context.outputDir, "invoice.json"), contents);
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "completed",
      summary: "Executed the supplied exporter and retained its actual JSON output.",
      observations: [`Exported invoice: ${contents}`],
      files: [
        {
          label: "invoice",
          path: "invoice.json",
          filename: "invoice.json",
          mediaType: "application/json",
        },
      ],
    }),
  );
}
