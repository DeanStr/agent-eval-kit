import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BrowserPointer } from "../src/browser/pointer.js";

test("click failures preserve bounded diagnostics for thrown values across contexts", async () => {
  const foreignError: unknown = runInNewContext(
    'new Error("foreign click failure\\nstack details")',
  );
  assert.equal(foreignError instanceof Error, false);
  const cases: Array<[unknown, string]> = [
    [new Error("click failure\nstack details"), "click failure"],
    [foreignError, "foreign click failure"],
    [{ message: "serialized click failure" }, "serialized click failure"],
    ["string failure", "string failure"],
    [null, "null"],
    [undefined, "undefined"],
    [new Error("x".repeat(300)), "x".repeat(200)],
  ];
  for (const [failure, expected] of cases) {
    const context = {
      refLocator: async () => ({
        scrollIntoViewIfNeeded: async () => {},
        evaluate: async () => null,
        click: async () => {
          throw failure;
        },
      }),
      refMissing: async () => false,
      snapshot: async () => assert.fail("failed clicks must not return a success snapshot"),
    } as unknown as ConstructorParameters<typeof BrowserPointer>[0];
    assert.equal(
      await new BrowserPointer(context).click("e1"),
      `ERROR: click on e1 failed: ${expected}`,
    );
  }
});
