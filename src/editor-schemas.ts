import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configurationJsonSchema } from "./config.js";
import { specificationJsonSchema } from "./specs.js";

export function editorSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ config: configurationJsonSchema(), spec: specificationJsonSchema() }).map(
      ([name, schema]) => [
        `${name}.schema.json`,
        `${JSON.stringify(
          {
            ...schema,
            title: `AEK ${name === "config" ? "configuration" : "evaluation specification"}`,
            $comment:
              "Generated from AEK input contracts. Run aek validate for cross-field rules, templates, references, and filesystem checks.",
          },
          null,
          2,
        )}\n`,
      ],
    ),
  );
}

// Build package-owned schemas as well as the portable copies written by init.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.join(import.meta.dirname, "schemas");
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(editorSchemas()))
    fs.writeFileSync(path.join(directory, name), content);
}
