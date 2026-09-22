# Reuse tests with a JSON command grader

This worked example connects ordinary Node.js tests to one AEK rubric item. It
requires only Node.js and AEK. The adapter translates test results; the assertions
stay in the test file.

Copy the [authoring example](../examples/authoring/README.md) to a disposable
directory as described in that walkthrough. It includes:

- [cart.test.mjs](../examples/authoring/cart.test.mjs): two ordinary `node:test`
  tests using `node:assert/strict` against `cart.mjs`.
- [test-adapter.mjs](../examples/authoring/test-adapter.mjs): the complete JSON
  adapter, with an explicit list of the two required test names.

From the copied directory, run the tests directly, then through the adapter:

```sh
node --test cart.test.mjs
node test-adapter.mjs
```

The adapter writes runner diagnostics to stderr and exactly one AEK object to
stdout on valid execution:

```json
{"verdict":"pass","reasoning":"Both required cart tests passed.","confidence":"high"}
```

## Connect it to AEK

Replace `specs/cart.yaml` in the disposable copy with this complete area definition:

```yaml
id: cart
title: Cart regression tests
description: Reuse the existing cart tests as one aggregate acceptance gate.
weight: 100
scenarios: []
rubric:
  - id: CART-TESTS
    criterion: Cart quantity and empty-cart tests pass
    weight: 1
    gate: true
    scenarios: []
    grader:
      type: command
      command: node test-adapter.mjs
      output: json
      methodFiles: [test-adapter.mjs, cart.test.mjs]
      timeoutSeconds: 30
    passCriteria: Both required tests execute and pass.
```

Keep the copied `evalkit.yaml`. Run `aek validate` and `aek run` using the CLI
invocation appropriate to your installation. This command-only evaluation needs no
provider login. It replaces the original two rubric items with one aggregate gate;
the walkthrough's original authoring map no longer matches these rubric IDs.
Use this as a standalone evaluation or update the map before running author commands.

`methodFiles` includes the adapter and tests, but excludes the product `cart.mjs`.
Changing a test or the required-test list changes the evaluator fingerprint;
changing the product lets you compare revisions using the same evaluator.

## Try each outcome

Make these changes one at a time in your disposable copy, restoring the original
files between trials:

| Change | Adapter stdout | Adapter exit | `aek run` exit |
| --- | --- | --- | --- |
| Original files | `pass` | 0 | 0 |
| In `cart.mjs`, omit `* line.quantity` from the calculation | `fail`, with the assertion message | 0 | 2 |
| Change one `test(...)` to `test.skip(...)` | `cannot_judge`, naming the skipped test | 0 | 2: required gate unavailable |
| Rename `cart.mjs` so its import fails | No verdict; diagnostic on stderr | 1 | 1 |
| Remove one required test | No verdict; missing-test diagnostic | 1 | 1 |

Skipped-test and missing-test trials change the evaluator and are adapter checks,
not comparable product revisions. A failed assertion never needs to exit 1 from
the adapter: `output: json` reserves nonzero exits for execution errors.

## How the adapter keeps the outcomes separate

It uses the [Node test runner's event stream](https://nodejs.org/download/release/v20.19.0/docs/api/test.html#class-testsstream),
so there is no saved report to reuse accidentally. It waits for the stream to end,
requires each expected test exactly once, and rejects unexpected test results.
Test output is kept off JSON stdout. Hook failures, timeouts, import failures, and
unrecognized exceptions take precedence over any assertion results.

This is deliberately an adapter for two top-level `node:assert` tests, not a
universal reporter. Nested suites and other assertion libraries need their own
explicit mapping. The error classification also depends on Node's test error
metadata; unknown shapes fail as execution errors. Keep preparation failures out
of product assertions and do not hide broken setup behind `skip`/`todo`. When a
product is expected to throw, assert that behavior in the test itself.

A real assertion failure establishes a failed aggregate even if another required
test is skipped; otherwise missing evidence yields `cannot_judge`. One aggregate
verdict cannot express per-test coverage. Use separate rubric items when you need
independent requirement scores or coverage.
