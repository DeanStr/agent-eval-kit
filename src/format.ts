import path from "node:path";

/** Display formatting only; JSON artifacts keep exact values. */

function rounded(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

/** A number with at most `decimals` decimal places and no trailing zeros. */
export function formatNumber(value: number, decimals = 1): string {
  return String(rounded(value, decimals));
}

/** A percentage with at most one decimal place, e.g. "86.7%"; null is "n/a". */
export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "n/a"
    : `${formatNumber(value)}%`;
}

/** A signed percentage-point delta with at most one decimal place, e.g. "+12.5"; null is "n/a". */
export function formatPctDelta(value: number | null): string {
  if (value === null) return "n/a";
  const display = rounded(value, 1);
  return `${display > 0 ? "+" : ""}${display}`;
}

/** A signed percentage-point change with its unit, e.g. "+12.5 points" or "-1 point". */
export function formatPoints(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "n/a";
  const display = formatPctDelta(delta);
  return `${display} point${Math.abs(rounded(delta, 1)) === 1 ? "" : "s"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO timestamp as "22 Oct 2026, 02:33 UTC"; unparseable recorded text is shown verbatim. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** A duration as "0.1 s", "42 s", "4 min 55 s", or "2 h 5 min". */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${formatNumber(milliseconds / 1000)} s`;
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours} h${minutes ? ` ${minutes} min` : ""}`
    : `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
}

/** "1 item", "2 items"; the plural defaults to the singular plus "s". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** A path for display and copy-paste: relative inside the working directory, else absolute. */
export function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  if (!relative) return ".";
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
}
