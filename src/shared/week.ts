// Copied from invoice-dashboard/lib/week.ts. Keep in sync: all 3 projects use the same rules.
// Weeks run Monday 00:00 to Sunday 23:59 in TIME_ZONE (same as a weekly email report).
// Plain .ts imports so `npm test` can run these files with Node directly.
import { TIME_ZONE } from "./config.ts";

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

// shortcut: uses the zone's offset at that moment; a zone with daylight saving could be 1h off
// on the switch weekend. Exact for Asia/Manila (no DST). Upgrade to a date library if that matters.
function offsetMs(ms: number) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((part) => part.type === "timeZoneName")!.value; // "GMT+08:00", or "GMT" for UTC
  const match = name.match(/([+-])(\d{2}):(\d{2})/);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000 : 0;
}

/** Start of the day (00:00 local time) that contains `ms`, as a timestamp. */
export function dayStart(ms: number) {
  const offset = offsetMs(ms);
  const local = ms + offset;
  return local - (((local % DAY) + DAY) % DAY) - offset;
}

/** Start of the week (Monday 00:00 local time) that contains `ms`, as a timestamp. */
export function weekStart(ms: number) {
  const day = dayStart(ms);
  const weekday = new Date(day + offsetMs(day)).getUTCDay(); // 0 = Sunday
  return day - ((weekday + 6) % 7) * DAY;
}

/** Local date of a day/week start, e.g. "2026-10-19". Used in URLs, file names and chart labels. */
export function dateKey(start: number) {
  return new Date(start + offsetMs(start)).toISOString().slice(0, 10);
}

/** "2026-10-19" -> 00:00 local time on that day, or null if it isn't a real date. */
export function parseDateKey(key: string | null | undefined) {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const utc = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(utc)) return null;
  const start = utc - offsetMs(utc);
  return dateKey(start) === key ? start : null; // rejects dates like 2026-02-31
}

/** Turns "2026-10-19" back into a week start, or null if it isn't a Monday. */
export function parseWeekKey(key: string | null | undefined) {
  const start = parseDateKey(key);
  return start != null && weekStart(start) === start ? start : null;
}
