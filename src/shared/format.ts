// Copied from invoice-dashboard/lib/format.ts. Keep in sync: all 3 projects use the same rules.
// Every number and date on the site is formatted here, so it looks the same everywhere.
import { FLAG_LABELS, TIME_ZONE } from "./config.ts";

const EMPTY = "—";

export function money(value: number | null | undefined, currency: string | null = "USD") {
  if (value == null) return EMPTY;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(value);
  } catch {
    // Unknown currency code from the extraction (e.g. "US$"): show the number and the raw code instead of crashing.
    return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

/** Milliseconds -> "45 min", "5.2 h", "3 days" */
export function duration(ms: number) {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 48 * 60) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

/** Short money for chart axes and big cards: $12.4K, $1.2M. */
export function moneyShort(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function count(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

/** 0.873 -> "87%" */
export function percent(ratio: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** Minutes -> "12.5 h" */
export function hours(minutes: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(minutes / 60)} h`;
}

/** Change vs the previous period: "+12%", "-3%", or null when there is nothing to compare with. */
export function change(current: number, previous: number) {
  if (!previous) return null;
  const ratio = (current - previous) / previous;
  return `${ratio > 0 ? "+" : ""}${percent(ratio)}`;
}

/** Change between two rates, in percentage points: 0.62 -> 0.65 is "+3 pts". */
export function pointsChange(current: number, previous: number) {
  const points = Math.round((current - previous) * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

/** "2026-10-19" -> "Oct 19" (chart labels) */
export function shortDate(key: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));
}

/** "2026-10-19" (a Monday) -> "Oct 19 – 25, 2026" */
export function weekLabel(key: string) {
  const start = new Date(`${key}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).formatRange(start, end);
}

// Plain dates like "2026-10-01" have no time, so they are read as UTC to avoid showing the day before.
export function date(value: string | null | undefined) {
  if (!value) return EMPTY;
  const isPlainDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: isPlainDate ? "UTC" : TIME_ZONE,
  }).format(new Date(value));
}

export function dateTime(value: string | null | undefined) {
  if (!value) return EMPTY;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(value));
}

/** "3 hours ago", "2 days ago" */
export function timeAgo(value: string | null | undefined, now = Date.now()) {
  if (!value) return EMPTY;
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function sourceLabel(source: string | null) {
  return source === "gmail" ? "Gmail" : source === "drive" ? "Google Drive" : (source ?? EMPTY);
}

export function flagLabel(code: string) {
  return FLAG_LABELS[code] ?? code;
}
