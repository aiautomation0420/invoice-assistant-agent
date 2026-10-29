// Copied from invoice-dashboard/lib/report.ts. Keep in sync: all 3 projects use the same rules.
// Turns invoice rows into the numbers shown on the Reports page (and later the Overview).
import { MINUTES_PER_INVOICE, type Status } from "./config.ts";
import { change, count, flagLabel, hours, money, percent, pointsChange } from "./format.ts";
import { DAY, WEEK, dateKey, dayStart, weekStart } from "./week.ts";

export type InvoiceRow = {
  status: Status;
  flag_reasons: string[] | null;
  total: number | null;
  created_at: string;
  vendor: string | null;
};

export type Summary = ReturnType<typeof summarize>;

export function summarize(rows: InvoiceRow[]) {
  const byStatus = (status: Status) => rows.filter((r) => r.status === status).length;
  const flags = new Map<string, number>();
  for (const row of rows) for (const code of row.flag_reasons ?? []) flags.set(code, (flags.get(code) ?? 0) + 1);
  const processed = rows.length;
  const clean = byStatus("clean");
  return {
    processed,
    clean,
    flagged: byStatus("flagged"),
    approved: byStatus("approved"),
    rejected: byStatus("rejected"),
    cleanRate: processed ? clean / processed : 0,
    // Flagged at any point = every non-clean status. Stays the same after a person reviews the invoice.
    flagRate: processed ? (processed - clean) / processed : 0,
    // Rejected invoices (duplicates, wrong amounts) are not money the business will pay.
    amount: rows.reduce((sum, r) => (r.status === "rejected" ? sum : sum + Number(r.total ?? 0)), 0),
    minutesSaved: processed * MINUTES_PER_INVOICE,
    flags: [...flags].map(([code, n]) => ({ code, count: n })).sort((a, b) => b.count - a.count),
  };
}

/** Per day or per week (local time) from `from` to `to`, including empty ones, for the charts. */
export function buckets(rows: InvoiceRow[], size: "day" | "week", from: number, to: number) {
  const startOf = size === "day" ? dayStart : weekStart;
  const all = new Map<number, { key: string; clean: number; flagged: number; amount: number }>();
  for (let t = startOf(from); t < to; t += size === "day" ? DAY : WEEK) all.set(t, { key: dateKey(t), clean: 0, flagged: 0, amount: 0 });
  for (const row of rows) {
    const bucket = all.get(startOf(Date.parse(row.created_at)));
    if (!bucket) continue;
    if (row.status === "clean") bucket.clean++;
    else bucket.flagged++; // flagged at any point, same as the flag rate
    if (row.status !== "rejected") bucket.amount += Number(row.total ?? 0);
  }
  return [...all.values()];
}

/** Vendors by amount (rejected invoices left out, same as the total amount). */
export function topVendors(rows: InvoiceRow[], limit: number) {
  const vendors = new Map<string, { vendor: string; amount: number; invoices: number }>();
  for (const row of rows) {
    if (!row.vendor || row.status === "rejected") continue;
    const v = vendors.get(row.vendor) ?? { vendor: row.vendor, amount: 0, invoices: 0 };
    v.amount += Number(row.total ?? 0);
    v.invoices++;
    vendors.set(row.vendor, v);
  }
  return [...vendors.values()].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

/** Plain-English math problems on one invoice (same tolerance as the n8n check: 1 cent). */
export function mathIssues(inv: {
  line_items: { amount?: number | null }[] | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
}) {
  const issues: string[] = [];
  const items = inv.line_items ?? [];
  const off = (a: number, b: number) => Math.abs(a - b) > 0.01;
  const linesSum = items.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  if (items.length && inv.subtotal != null && off(linesSum, Number(inv.subtotal))) {
    issues.push(`Line items add up to ${money(linesSum, inv.currency)}, but the subtotal says ${money(inv.subtotal, inv.currency)}.`);
  }
  if (inv.subtotal != null && inv.total != null) {
    const expected = Number(inv.subtotal) + Number(inv.tax ?? 0);
    if (off(expected, Number(inv.total))) {
      issues.push(`Subtotal + tax = ${money(expected, inv.currency)}, but the total says ${money(inv.total, inv.currency)}.`);
    }
  }
  return issues;
}

type Kind = "count" | "rate" | "money" | "minutes";
const show: Record<Kind, (n: number) => string> = { count, rate: (n) => percent(n, 1), money, minutes: hours };
// Plain numbers for the CSV so spreadsheets can do math with them.
const raw: Record<Kind, (n: number) => string | number> = {
  count: (n) => n,
  rate: (n) => (n * 100).toFixed(1),
  money: (n) => n.toFixed(2),
  minutes: (n) => (n / 60).toFixed(1),
};

export function metrics(current: Summary, previous: Summary) {
  const rows: { label: string; csvLabel?: string; kind: Kind; key: keyof Summary; status?: Status }[] = [
    { label: "Invoices processed", kind: "count", key: "processed" },
    { label: "Clean", kind: "count", key: "clean", status: "clean" },
    { label: "Flagged (awaiting review)", kind: "count", key: "flagged", status: "flagged" },
    { label: "Approved after review", kind: "count", key: "approved", status: "approved" },
    { label: "Rejected", kind: "count", key: "rejected", status: "rejected" },
    { label: "Clean rate", csvLabel: "Clean rate (%)", kind: "rate", key: "cleanRate" },
    { label: "Flag rate", csvLabel: "Flag rate (%)", kind: "rate", key: "flagRate" },
    { label: "Total amount (excl. rejected)", csvLabel: "Total amount USD (excl. rejected)", kind: "money", key: "amount" },
    { label: "Hours saved", kind: "minutes", key: "minutesSaved" },
  ];
  return rows.map(({ label, csvLabel, kind, key, status }) => {
    const now = current[key] as number;
    const before = previous[key] as number;
    return {
      label,
      status,
      now: show[kind](now),
      before: show[kind](before),
      change: kind === "rate" ? (previous.processed ? pointsChange(now, before) : null) : change(now, before),
      csv: [csvLabel ?? label, raw[kind](now), raw[kind](before)],
    };
  });
}

/** Flag reasons for both weeks, most common this week first. */
export function flagRows(current: Summary, previous: Summary) {
  const codes = [...new Set([...current.flags, ...previous.flags].map((f) => f.code))];
  const find = (s: Summary, code: string) => s.flags.find((f) => f.code === code)?.count ?? 0;
  return codes
    .map((code) => ({ code, label: flagLabel(code), now: find(current, code), before: find(previous, code) }))
    .sort((a, b) => b.now - a.now || b.before - a.before);
}

function csvCell(value: string | number | null) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: (string | number | null)[][]) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function reportCsv(week: string, current: Summary, previous: Summary) {
  const metricRows = metrics(current, previous);
  return toCsv([
    ["Invoice weekly report", `Week of ${week}`],
    [],
    ["Metric", "This week", "Last week", "Change"],
    ...metricRows.map((m) => [...m.csv, m.change ?? ""]),
    [],
    ["Flag reason", "This week", "Last week"],
    ...flagRows(current, previous).map((f) => [f.label, f.now, f.before]),
  ]);
}
