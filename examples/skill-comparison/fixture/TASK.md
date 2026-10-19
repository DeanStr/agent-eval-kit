Extend total(lines, discountPercent = 0) with an optional integer discount from
0 through 100. Sum integer priceCents * quantity first, then apply the discount
once to the subtotal and round the final total to the nearest integer cent using
Math.round. Empty carts total zero. Existing calls without a discount must keep
working. Keep TASK.md and cart.test.mjs unchanged. Put any additional tests in
separate files. Edit cart.mjs to implement this task; no new runtime dependencies
or other implementation files.
