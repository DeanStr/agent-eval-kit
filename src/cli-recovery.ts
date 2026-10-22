/** Commands printed for recovery must also work when a project path contains spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
