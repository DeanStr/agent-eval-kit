import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runContainer, containerArgs, mount } from "./docker-runner.mjs";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const { image } = JSON.parse(fs.readFileSync(new URL("./runtime.json", import.meta.url), "utf8"));
// Inputs contain no expected outputs. The artifact runs in a container without
// networking, credentials, evaluator code, expectations, or the host repository.
const cases = [
  ["quantity", [{ priceCents: 500, quantity: 2 }]],
  ["empty", []],
  ["discount", [{ priceCents: 500, quantity: 2 }], 10],
  ["round-once", [{ priceCents: 5, quantity: 2 }], 50],
  [
    "round-across-lines",
    [
      { priceCents: 5, quantity: 1 },
      { priceCents: 5, quantity: 1 },
    ],
    50,
  ],
  ["free", [{ priceCents: 531, quantity: 3 }], 100],
  ["zero", [{ priceCents: 531, quantity: 3 }], 0],
];
const script = `import fs from 'node:fs';
import {total} from '/target/cart.mjs';
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(([id,...args])=>({id,actual:total(...args)}))));`;
const name = `aek-observe-${randomUUID()}`;
const result = await runContainer(
  name,
  [
    ...containerArgs(name),
    "--network=none",
    "--mount",
    mount(context.sources.cart.path, "/target/cart.mjs", true),
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    script,
  ],
  {
    directory: context.outputDir,
    prefix: "probe",
    timeoutSeconds: 20,
    input: JSON.stringify(cases),
  },
);
if (result.error || result.exitCode !== 0)
  throw new Error(
    `Artifact observation execution error: ${JSON.stringify(result)}; see probe.stderr`,
  );
const values = JSON.parse(fs.readFileSync(path.join(context.outputDir, "probe.stdout"), "utf8"));
if (
  !Array.isArray(values) ||
  values.length !== cases.length ||
  values.some((value, index) => value.id !== cases[index][0] || !Number.isFinite(value.actual))
)
  throw new Error("Artifact returned malformed observations; no verdict produced");
fs.writeFileSync(path.join(context.outputDir, "values.json"), JSON.stringify(values));
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: "Executed the sealed candidate artifact with fixed inputs in an isolated container.",
    observations: values.map(({ id, actual }) => `${id}: ${actual}`),
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
