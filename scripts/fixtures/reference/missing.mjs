export function itemCount(items) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}
