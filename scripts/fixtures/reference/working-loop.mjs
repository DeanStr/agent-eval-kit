export function total(items) {
  let cents = 0;
  for (const { unitPriceCents, quantity } of items) cents += unitPriceCents * quantity;
  return cents;
}
