import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const module = path.join(context.outputDir, "cart.mjs");
fs.copyFileSync(context.sources.cart.path, module);
const cart = await import(pathToFileURL(module).href);
const values = { quantity: cart.total([{ priceCents: 500, quantity: 2 }]), empty: cart.total([]) };
fs.writeFileSync(path.join(context.outputDir, "values.json"), JSON.stringify(values));
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: "Executed the cart snapshot.",
    observations: [JSON.stringify(values)],
    files: [
      {
        label: "values",
        path: "values.json",
        filename: "values.json",
        mediaType: "application/json",
      },
    ],
  }),
);
