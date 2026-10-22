import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { z } from "zod";
import { editorSchemas } from "../src/editor-schemas.js";
import { initializeProject, STARTER_KINDS } from "../src/templates.js";

test("generated editor schemas accept starter inputs, templates and dataset references", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const generated = editorSchemas();
  const config = z.fromJSONSchema(JSON.parse(generated["config.schema.json"]!));
  const spec = z.fromJSONSchema(JSON.parse(generated["spec.schema.json"]!));
  for (const kind of STARTER_KINDS) {
    for (const file of initializeProject(path.join(directory, kind), kind)) {
      if (!file.endsWith(".yaml") || file.endsWith("fixtures.yaml")) continue;
      const result = (file.endsWith("evalkit.yaml") ? config : spec).safeParse(
        YAML.parse(fs.readFileSync(file, "utf8")),
      );
      assert.equal(result.success, true, `${file}: ${result.error?.message}`);
    }
  }
  assert.equal(
    config.safeParse({
      version: 1,
      project: { name: "Environment" },
      target: { kind: "web", url: `\${TARGET_URL}` },
      agent: { provider: `\${PROVIDER}` },
    }).success,
    true,
  );
  assert.equal(
    config.safeParse({
      version: 1,
      project: { name: "Invalid" },
      target: { kind: "command" },
      scoring: { minimumCoverage: "wrong" },
    }).success,
    false,
  );
  const input = {
    id: "text",
    title: "Text",
    description: "Template and external cases",
    weight: 100,
    datasets: { messages: { file: "messages.json" } },
    templates: {
      review: {
        weight: 1,
        criterion: "Reviewed",
        passCriteria: "Approved",
        grader: { type: "manual" },
        manualInstructions: "Inspect the wording",
      },
    },
    rubric: [{ id: "READABLE", template: "review" }],
  };
  assert.equal(spec.safeParse(input).success, true);
  assert.equal(spec.safeParse({ ...input, unknownField: true }).success, false);
});
