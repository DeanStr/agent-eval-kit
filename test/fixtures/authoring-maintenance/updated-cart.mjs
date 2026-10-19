// New documented feature plus a genuine regression in the existing contract.
export function total(lines) {
  return lines.reduce((sum, line) => sum + line.priceCents, 0);
}
export function discountTotal(lines, percent) {
  const subtotal = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  return Math.round((subtotal * (100 - percent)) / 100);
}
