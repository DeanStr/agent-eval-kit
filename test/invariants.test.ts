import assert from "node:assert/strict";
import test from "node:test";
import { requireDefined, omitUndefined, omitUndefinedDeep } from "../src/invariants.js";

test("required values preserve falsy values and fail with the missing contract", () => {
  for (const value of [0, false, "", null])
    assert.equal(requireDefined(value, "test value"), value);
  assert.throws(
    () => requireDefined(undefined, "capture frame 2"),
    /Missing required value: capture frame 2/,
  );
});

test("optional object fields are absent while explicit null and nested values survive", () => {
  const nested = { missing: undefined };
  const result = omitUndefined({
    missing: undefined,
    zero: 0,
    no: false,
    empty: "",
    nil: null,
    nested,
  });
  assert.equal(Object.hasOwn(result, "missing"), false);
  assert.deepEqual(result, { zero: 0, no: false, empty: "", nil: null, nested });
  assert.equal(result.nested, nested);
});

test("validated schema data omits optional fields recursively without losing prototype-named keys", () => {
  const named = JSON.parse('{"__proto__":{"label":"kept"}}');
  const input = {
    config: { absent: undefined, nil: null },
    cases: [{ absent: undefined, value: 0 }],
    named,
  };
  const result = omitUndefinedDeep(input);
  assert.deepEqual(result, { config: { nil: null }, cases: [{ value: 0 }], named });
  assert.equal(Object.hasOwn(result.named, "__proto__"), true);
  assert.equal(Object.hasOwn(input.config, "absent"), true);
});
