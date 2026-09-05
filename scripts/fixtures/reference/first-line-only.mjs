export function total(items) {
  const item = items[0];
  return item ? item.unitPriceCents * item.quantity : 0;
}
