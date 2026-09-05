const pad2 = (n: number) => String(n).padStart(2, "0");

/** "9:30 AM" | "14:05" | "March 5, 2026 9:30am" -> {h, m}. */
function parseClock(text: string): { h: number; m: number } | null {
  const t = text.trim();
  let m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3] ? m[3].toLowerCase().replace(/\./g, "") : "";
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h > 23 || min > 59 ? null : { h, m: min };
  }
  m = /^(\d{1,2})\s*([ap]\.?m\.?)$/i.exec(t);
  if (m) {
    let h = Number(m[1]);
    const ap = m[2].toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h > 23 ? null : { h, m: 0 };
  }
  return null;
}

function parseCalendarDate(text: string): Date | null {
  const t = text.trim();
  const checkedDate = (year: number, month: number, day: number): Date | null => {
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date
      : null;
  };
  // Parse ISO by hand: `new Date("2026-03-05")` is UTC midnight, which slides
  // to the previous day for anyone west of Greenwich.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[T\s])/.exec(t);
  if (iso) return checkedDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=$|\s)/.exec(t);
  if (us) return checkedDate(Number(us[3]), Number(us[1]), Number(us[2]));

  const months: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(\d{4})(?:\s+.*)?$/i.exec(t);
  if (monthFirst) {
    const month = months[monthFirst[1].toLowerCase()];
    return month ? checkedDate(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*,?\s*(\d{4})(?:\s+.*)?$/i.exec(t);
  if (dayFirst) {
    const month = months[dayFirst[2].toLowerCase()];
    return month ? checkedDate(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  return null;
}

export const TEMPORAL_FORMATS: Record<string, string> = {
  date: "YYYY-MM-DD",
  time: "HH:MM (24-hour)",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-Www",
};

/**
 * Temporal inputs only accept one exact wire format; a human-shaped value like
 * "March 5, 2026" makes Playwright's fill() throw "Malformed value". Agenda and
 * CFP-deadline steps are full of those, and the raw error reads as "this app
 * has no date field", so normalise before filling.
 */
export function normalizeTemporal(type: string, text: string): string | null {
  const t = text.trim();
  if (type === "time") {
    const c = parseClock(t);
    return c ? `${pad2(c.h)}:${pad2(c.m)}` : null;
  }
  // Month and week have native wire formats that intentionally contain no
  // calendar day. Recognize those before asking the full-date parser to turn
  // human-shaped values into a Date.
  if (type === "month") {
    const nativeMonth = /^(\d{4})-(\d{2})$/.exec(t);
    if (nativeMonth) {
      const year = Number(nativeMonth[1]);
      const month = Number(nativeMonth[2]);
      return year >= 1 && month >= 1 && month <= 12 ? t : null;
    }
  }
  if (type === "week") {
    const nativeWeek = /^(\d{4})-W(\d{2})$/.exec(t);
    if (nativeWeek) {
      const year = Number(nativeWeek[1]);
      const week = Number(nativeWeek[2]);
      if (year < 1 || week < 1 || week > 53) return null;
      // December 28 is always in the final ISO week of its calendar year.
      const lastThursday = new Date(0);
      lastThursday.setHours(0, 0, 0, 0);
      lastThursday.setFullYear(year, 11, 28);
      lastThursday.setDate(lastThursday.getDate() - ((lastThursday.getDay() + 6) % 7) + 3);
      const firstThursday = new Date(0);
      firstThursday.setHours(0, 0, 0, 0);
      firstThursday.setFullYear(year, 0, 4);
      firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
      const lastWeek = 1 + Math.round((lastThursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
      return week <= lastWeek ? t : null;
    }
  }
  const d = parseCalendarDate(t);
  if (!d) return null;
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (type === "date") return ymd;
  if (type === "month") return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if (type === "datetime-local") {
    const c = parseClock(t);
    // A date without a time deliberately means local midnight, but once the
    // caller supplies a clock component it must be valid. Never turn an
    // attempted 25:00 (or another malformed native datetime) into 00:00.
    const includesClock =
      t.includes("T") || /(?:^|\s)\d{1,2}(?::\d{2}|\s*[ap]\.?m\.?)(?:\s|$)/i.test(t);
    if (includesClock && !c) return null;
    const clock = c ?? { h: d.getHours(), m: d.getMinutes() };
    return `${ymd}T${pad2(clock.h)}:${pad2(clock.m)}`;
  }
  if (type === "week") {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7) + 3);
    const firstThu = new Date(dt.getFullYear(), 0, 4);
    firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3);
    const week = 1 + Math.round((dt.getTime() - firstThu.getTime()) / (7 * 86_400_000));
    return `${dt.getFullYear()}-W${pad2(week)}`;
  }
  return null;
}
