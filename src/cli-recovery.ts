/** Commands printed for recovery must also work when a project path contains spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote only when needed, so printed commands stay readable for ordinary paths. */
export function shellArg(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}
