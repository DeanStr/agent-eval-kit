import { run } from "node:test";
import { fileURLToPath } from "node:url";

// Project-owned adapter: these two top-level node:assert tests are required.
// No assertions or expected product values are duplicated here.
const file = fileURLToPath(new URL("./cart.test.mjs", import.meta.url));
const expected = new Set(["quantity contributes to total", "empty cart totals zero"]);
const seen = new Set();
const failures = [];
const unavailable = [];
const errors = [];

try {
  // Read this invocation's events, never a possibly stale report file.
  for await (const { type, data } of run({ files: [file], timeout: 5000 })) {
    if (type === "test:stdout" || type === "test:stderr" || type === "test:diagnostic") {
      process.stderr.write(`${data.message}\n`);
    }
    if (type !== "test:pass" && type !== "test:fail") continue;

    if (
      data.file !== file ||
      data.nesting !== 0 ||
      !expected.has(data.name) ||
      seen.has(data.name)
    ) {
      errors.push(`Unexpected or duplicate test result: ${data.name}`);
      continue;
    }
    seen.add(data.name);
    const error = data.details.error;
    // Hook failures, crashes, timeouts, and ordinary exceptions are not product verdicts.
    if (
      type === "test:fail" &&
      (error?.failureType !== "testCodeFailure" || error?.cause?.code !== "ERR_ASSERTION")
    ) {
      errors.push(`${data.name}: ${error?.message ?? "Unknown runner error"}`);
    } else if (data.skip || data.todo) {
      unavailable.push(`${data.name}: ${data.skip || data.todo}`);
    } else if (type === "test:fail") {
      failures.push(`${data.name}: ${error.cause.message}`);
    }
  }

  for (const name of expected) {
    if (!seen.has(name)) errors.push(`Required test did not report a result: ${name}`);
  }
  // Errors take precedence, even when other tests passed or found a real defect.
  if (errors.length) throw new Error(errors.join("\n"));

  const verdict = failures.length ? "fail" : unavailable.length ? "cannot_judge" : "pass";
  const reasoning = [...failures, ...unavailable].join("\n") || "Both required cart tests passed.";
  console.log(
    JSON.stringify({ verdict, reasoning, confidence: verdict === "cannot_judge" ? "low" : "high" }),
  );
  // A valid fail/cannot_judge is still a successfully executed JSON grader: exit 0.
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
