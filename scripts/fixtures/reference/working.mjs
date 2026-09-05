export function total(items) {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}
