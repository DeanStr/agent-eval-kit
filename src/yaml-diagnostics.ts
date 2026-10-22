import YAML from "yaml";
import type { z } from "zod";

/** Locate the closest existing YAML node, including missing required fields. */
export function yamlValidationError(file: string, source: string, error: z.ZodError): Error {
  const counter = new YAML.LineCounter();
  const document = YAML.parseDocument(source, { lineCounter: counter });
  const details = error.issues.map((issue) => {
    const keys = [...issue.path];
    let node = document.getIn(keys, true);
    while (!YAML.isNode(node) && keys.length) {
      keys.pop();
      node = document.getIn(keys, true);
    }
    const position = YAML.isNode(node) && node.range ? counter.linePos(node.range[0]) : undefined;
    const location = position ? `${file}:${position.line}:${position.col}` : file;
    return `${location} ${issue.path.join(".") || "document"}: ${issue.message}`;
  });
  return new Error(`Invalid ${file}:\n  - ${details.join("\n  - ")}`);
}
