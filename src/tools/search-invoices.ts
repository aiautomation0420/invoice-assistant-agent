import { z } from "zod";
import { STATUSES } from "../shared/config.ts";
import { money } from "../shared/format.ts";
import { FLAG_CODES, brief, dateField, dateRange, day, daysOverdue, defineTool, isOverdue, payableTotal, today } from "./common.ts";

const MAX_LISTED = 25;

export default defineTool({
  name: "search_invoices",
  description:
    "Find invoices by status, vendor, date range, amount range, flag reason, or overdue. " +
    `Lists at most ${MAX_LISTED} invoices (newest processed first; soonest due first with date_field=due_date; most overdue first with overdue=true, with days_overdue; latest decision first when filtering on reviews), plus the count and total amount of ALL matches (rejected invoices left out of the total, same as the dashboard). ` +
    "Pick the date with date_field: processed (default, matches the dashboard), invoice_date ('invoices dated in October') or due_date ('what's due this week'). " +
    "For 'what's overdue' / 'past due', set overdue=true (no dates needed). " +
    "For 'what was approved or rejected this week and why', use date_field=reviewed with the week's dates and reviewed_by=anyone: each row then shows when, by whom and the review note. " +
    "For follow-ups like 'which of those are over $5,000?', repeat the earlier filters and add min_total.",
  input: {
    status: z.enum(STATUSES).optional().describe("clean = passed every check; flagged = waiting for review; approved / rejected = reviewed by a person"),
    vendor: z.string().max(100).optional().describe("Whole or part of the vendor name, e.g. 'Summit'"),
    date_field: dateField,
    from: day.optional().describe("First date, YYYY-MM-DD, included"),
    to: day.optional().describe("Last date, YYYY-MM-DD, included"),
    min_total: z.number().nonnegative().optional().describe("Invoice total at least this many USD"),
    max_total: z.number().nonnegative().optional().describe("Invoice total at most this many USD"),
    flag: z.enum(FLAG_CODES).optional().describe("Only invoices flagged for this reason"),
    reviewed_by: z
      .enum(["anyone", "invoice_assistant"])
      .optional()
      .describe("Only invoices a person has approved or rejected: anyone, or only decisions made in this Invoice Assistant chat"),
    overdue: z
      .boolean()
      .optional()
      .describe("true = only invoices approved for payment (clean or approved) whose due date is before today (Asia/Manila) and that aren't fully paid"),
  },
  async run(args, { data }) {
    let rows = await data.invoices({
      status: args.status,
      vendor: args.vendor,
      ...dateRange(args.date_field, args.from, args.to),
      minTotal: args.min_total,
      maxTotal: args.max_total,
      flag: args.flag,
      reviewedBy: args.reviewed_by,
    });
    let paymentsNote: string | undefined;
    const todayKey = today();
    if (args.overdue) {
      const payments = await data.payments(rows.map((r) => r.id));
      rows = rows.filter((r) => isOverdue(r, payments, todayKey));
      if (payments == null) {
        paymentsNote = "Payments aren't tracked yet, so every clean or approved invoice past its due date is counted as unpaid. Some may already be paid.";
      }
    }
    // Due-date questions read best soonest due first; overdue = most overdue first (same order). Missing due dates go last.
    if (args.overdue || args.date_field === "due_date") {
      rows = rows.toSorted((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
    } else if (args.reviewed_by || args.date_field === "reviewed") {
      rows = rows.toSorted((a, b) => (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "")); // latest decision first
    }
    if (!rows.length) return { matches: 0, message: "No invoices match these filters.", ...(paymentsNote && { payments_note: paymentsNote }) };
    return {
      matches: rows.length,
      total_amount_excluding_rejected: money(payableTotal(rows)),
      listed: Math.min(rows.length, MAX_LISTED),
      invoices: rows
        .slice(0, MAX_LISTED)
        .map((r) => (args.overdue ? { ...brief(r), days_overdue: daysOverdue(r, todayKey) } : brief(r))),
      ...(rows.length > MAX_LISTED && { note: `Only the first ${MAX_LISTED} are listed. Narrow the filters to see the others.` }),
      ...(paymentsNote && { payments_note: paymentsNote }),
    };
  },
});
