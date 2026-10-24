import YAML from "yaml";
import type { z } from "zod";
import { displayPath } from "./format.js";
import { closestMatch } from "./suggest.js";

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

function branches(schema: JsonSchema): JsonSchema[] {
  return [
    schema,
    ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(
      branches,
    ),
  ];
}

/** Property names an object at `path` may have, across every union branch of the schema. */
function knownKeys(schema: JsonSchema, path: PropertyKey[]): string[] {
  let nodes = branches(schema);
  for (const segment of path) {
    nodes = nodes
      .flatMap((node): JsonSchema[] => {
        if (typeof segment === "number") return node.items ? [node.items] : [];
        const property = node.properties?.[String(segment)];
        if (property) return [property];
        return typeof node.additionalProperties === "object" ? [node.additionalProperties] : [];
      })
      .flatMap(branches);
  }
  return [...new Set(nodes.flatMap((node) => Object.keys(node.properties ?? {})))];
}

/**
 * Locate the closest existing YAML node, including missing required fields, and suggest
 * the intended key or value for typos. With a JSON schema, an unknown key that explains a
 * missing required key is reported once, as the typo.
 */
export function yamlValidationError(
  file: string,
  source: string,
  error: z.ZodError,
  schema?: unknown,
): Error {
  const counter = new YAML.LineCounter();
  const document = YAML.parseDocument(source, { lineCounter: counter });
  const shown = displayPath(file);
  const explained = new Set<string>();
  const messages = new Map<z.core.$ZodIssue, string>();
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys" && schema) {
      const candidates = knownKeys(schema as JsonSchema, issue.path);
      const parts = issue.keys.map((key) => {
        const match = closestMatch(key, candidates);
        if (match) explained.add([...issue.path, match].join("."));
        return `Unknown key "${key}"${match ? `. Did you mean "${match}"?` : ""}`;
      });
      messages.set(issue, parts.join("; "));
    } else if (
      (issue.code === "invalid_union" || issue.code === "invalid_value") &&
      ("options" in issue || "values" in issue)
    ) {
      const options =
        (issue as { options?: unknown[]; values?: unknown[] }).options ??
        (issue as { values?: unknown[] }).values;
      const value = document.getIn(issue.path);
      const match =
        typeof value === "string" && options
          ? closestMatch(
              value,
              options.filter((option): option is string => typeof option === "string"),
            )
          : undefined;
      messages.set(issue, `${issue.message}${match ? `. Did you mean "${match}"?` : ""}`);
    }
  }
  const details = error.issues
    .filter(
      (issue) =>
        !(
          issue.code === "invalid_type" &&
          document.getIn(issue.path) === undefined &&
          explained.has(issue.path.join("."))
        ),
    )
    .map((issue) => {
      const keys = [...issue.path];
      let node = document.getIn(keys, true);
      while (!YAML.isNode(node) && keys.length) {
        keys.pop();
        node = document.getIn(keys, true);
      }
      const position = YAML.isNode(node) && node.range ? counter.linePos(node.range[0]) : undefined;
      const location = position ? `${shown}:${position.line}:${position.col}` : shown;
      return `${location} ${issue.path.join(".") || "document"}: ${messages.get(issue) ?? issue.message}`;
    });
  return new Error(`Invalid ${shown}:\n  - ${details.join("\n  - ")}`);
}
