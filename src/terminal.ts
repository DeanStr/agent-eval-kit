/** Semantic emphasis for terminal output; files and JSON always receive plain text. */
export type Tone = "pass" | "fail" | "warn" | "muted" | "info" | "bold";

const codes: Record<Tone, [number, number]> = {
  pass: [32, 39],
  fail: [31, 39],
  warn: [33, 39],
  info: [36, 39],
  muted: [2, 22],
  bold: [1, 22],
};

/** Honors NO_COLOR and FORCE_COLOR (https://no-color.org), otherwise colors only TTYs. */
export function colorEnabled(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}

export function paint(text: string, tone: Tone | undefined, enabled: boolean): string {
  if (!tone || !enabled) return text;
  const [open, close] = codes[tone];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

/** First line of a reasoning string, shortened for a one-line terminal summary. */
export function oneLine(text: string, maximum = 110): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1).trimEnd()}…` : line;
}
