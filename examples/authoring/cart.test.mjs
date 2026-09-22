import assert from "node:assert/strict";
import test from "node:test";
import { total } from "./cart.mjs";

test("quantity contributes to total", () => {
  assert.equal(total([{ priceCents: 500, quantity: 2 }]), 1000);
});

test("empty cart totals zero", () => {
  assert.equal(total([]), 0);
});
