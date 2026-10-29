// What every tool is made of, plus small helpers the tools share.
import { z } from "zod";
import type { Data, Invoice, Payment } from "../data.ts";
import { FLAG_HELP, FLAG_LABELS } from "../shared/config.ts";
import { date, dateTime, flagLabel, money } from "../shared/format.ts";
import { DAY, dateKey, dayStart, parseDateKey } from "../shared/week.ts";

/** What a tool gets besides its input: the data, and ways to ask the user directly (work the same in both AI modes). */
export type Context = {
  data: Data;
  /** Ask a y/n question; true only for y/yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Ask for a line of text (e.g. a review reason); "" when the user just presses Enter. */
  ask: (question: string) => Promise<string>;
};

/** A normal TypeScript function plus the name, description and input rules Claude sees. */
export type Tool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  run: (args: any, ctx: Context) => Promise<unknown>;
};

export function defineTool<S extends z.ZodRawShape>(tool: {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: Context) => Promise<unknown>;
}): Tool {
  return tool;
}

export const FLAG_CODES = Object.keys(FLAG_LABELS) as [string, ...string[]];

export const day = z
  .string()
  .refine((value) => parseDateKey(value) != null, "Use a real date written as YYYY-MM-DD");

export const dateField = z
  .enum(["processed", "invoice_date", "due_date", "reviewed"])
  .default("processed")
  .describe(
    "Which date from/to apply to. processed (default) = the day the AI agent processed the invoice, matching the dashboard; " +
      "use it for 'this month', 'last week', 'how much did we spend'. invoice_date = the date printed on the invoice; use it for " +
      "'invoices dated in October'. due_date = when payment is due; use it for 'what's due this week'. reviewed = the day a person " +
      "approved or rejected it; use it for 'what was approved or rejected this week'.",
  );

/** from/to (both included) on the chosen date -> the filter the data layer expects. Processed dates are Asia/Manila days. */
export function dateRange(field: z.infer<typeof dateField>, from?: string, to?: string) {
  if (field === "invoice_date" || field === "due_date") return from || to ? { dateColumn: field, dateFrom: from, dateTo: to } : {};
  if (field === "reviewed") {
    return { reviewedFrom: from ? parseDateKey(from)! : undefined, reviewedTo: to ? parseDateKey(to)! + DAY : undefined };
  }
  return {
    createdFrom: from ? parseDateKey(from)! : undefined,
    createdTo: to ? parseDateKey(to)! + DAY : undefined,
  };
}

/** Today's date in Asia/Manila, "YYYY-MM-DD". */
export function today(now = Date.now()) {
  return dateKey(dayStart(now));
}

/** Approved for payment (clean or approved), due before today, and not fully paid. */
export function isOverdue(inv: Invoice, payments: Payment[] | null, todayKey = today()) {
  if (inv.status !== "clean" && inv.status !== "approved") return false;
  if (!inv.due_date || inv.due_date >= todayKey) return false;
  return payments == null || inv.total == null || paidAmount(inv, payments) < Number(inv.total) - 0.01;
}

export function daysOverdue(inv: Invoice, todayKey = today()) {
  return Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${inv.due_date}T00:00:00Z`)) / DAY);
}

/** Sum of totals, rejected invoices left out (dashboard rule: rejected money will not be paid). */
export function payableTotal(rows: Pick<Invoice, "status" | "total">[]) {
  return rows.reduce((sum, r) => (r.status === "rejected" ? sum : sum + Number(r.total ?? 0)), 0);
}

export function flagDetails(codes: string[] | null) {
  return (codes ?? []).map((code) => ({ code, label: flagLabel(code), explanation: FLAG_HELP[code] ?? "Unknown flag code." }));
}

/** One short line per invoice for lists. */
export function brief(inv: Invoice) {
  return {
    id: inv.id,
    invoice_number: inv.invoice_number ?? "(none)",
    vendor: inv.vendor ?? "(unreadable file)",
    invoice_date: date(inv.invoice_date),
    due_date: date(inv.due_date),
    total: money(inv.total, inv.currency),
    status: inv.status,
    flags: (inv.flag_reasons ?? []).map(flagLabel),
    processed: date(inv.created_at),
    ...(inv.reviewed_at && { reviewed: dateTime(inv.reviewed_at), reviewed_by: inv.reviewed_by ?? "reviewer email (n8n)", review_note: inv.review_note ?? "—" }),
  };
}

export function paidAmount(inv: Pick<Invoice, "id">, payments: Payment[]) {
  return payments.filter((p) => p.invoice_id === inv.id).reduce((sum, p) => sum + Number(p.amount), 0);
}

export function paymentStatus(inv: Invoice, payments: Payment[] | null) {
  if (payments == null) return "Not tracked yet (the payments table isn't set up)";
  if (inv.status === "rejected") return "Not payable (rejected)";
  const paid = paidAmount(inv, payments);
  if (paid === 0) return "Unpaid";
  if (inv.total != null && paid >= Number(inv.total) - 0.01) return `Paid (${money(paid, inv.currency)})`;
  return `Partly paid: ${money(paid, inv.currency)} of ${money(inv.total, inv.currency)}`;
}
