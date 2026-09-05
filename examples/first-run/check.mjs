import { total } from './cart.mjs';

const checks = {
  quantity: { lines: [{ priceCents: 500, quantity: 2 }], expected: 1000 },
  empty: { lines: [], expected: 0 },
};
const check = checks[process.argv[2]];
if (!check) {
  console.error('Usage: node check.mjs quantity|empty');
  process.exit(64);
}
// Import and runtime failures propagate as execution errors. A mismatch is a product verdict.
const actual = total(check.lines);
console.log(JSON.stringify({
  verdict: actual === check.expected ? 'pass' : 'fail',
  confidence: 'high',
  reasoning: `Expected ${check.expected} cents; received ${actual} cents.`,
  evidenceRefs: [],
}));
