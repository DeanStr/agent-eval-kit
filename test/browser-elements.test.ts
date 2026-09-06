import assert from "node:assert/strict";
import test from "node:test";
import type { Frame } from "playwright";
import { collectFrame } from "../src/browser/elements.js";

test("element detection rejects failed or timed-out observation instead of returning empty results", async () => {
  const broken = {
    evaluate: () => Promise.reject(new Error("Execution context destroyed")),
  } as unknown as Frame;
  await assert.rejects(
    collectFrame(broken, 0, true, 100),
    /Element detection failed: Execution context destroyed/,
  );
  const stalled = { evaluate: () => new Promise(() => {}) } as unknown as Frame;
  await assert.rejects(
    collectFrame(stalled, 0, true, 10),
    /Element detection timed out after 10ms/,
  );
  const empty = {
    evaluate: () => Promise.resolve({ out: [], last: 0, modalLabel: null, hidden: 0 }),
  } as unknown as Frame;
  assert.deepEqual(await collectFrame(empty, 0, true, 100), {
    out: [],
    last: 0,
    modalLabel: null,
    hidden: 0,
  });
});
