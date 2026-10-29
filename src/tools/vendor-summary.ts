import { z } from "zod";
import type { Invoice, Payment } from "../data.ts";
import { money, percent } from "../shared/format.ts";
import { dateField, dateRange, day, defineTool, paidAmount, payableTotal } from "./common.ts";

const MAX_VENDORS = 25;

export default defineTool({
  name: "vendor_summary",
  description:
    "Per-vendor numbers for a period: total spent (invoice totals, rejected left out, same as the dashboard), invoice count, " +
    "paid vs unpaid amount, and problem rate (share of invoices that failed at least one check, including ones later approved or rejected). " +
    "Pick the date with date_field: processed (default, matches the dashboard), invoice_date or due_date. Leave out from/to for all time. " +
    "Use sort_by 'problem_invoices' for 'which vendors send the most problem invoices?'.",
  input: {
    date_field: dateField,
    from: day.optional().describe("First date, YYYY-MM-DD, included"),
    to: day.optional().describe("Last date, YYYY-MM-DD, included"),
    vendor: z.string().max(100).optional().describe("Only vendors whose name contains this, e.g. 'Summit'"),
    sort_by: z.enum(["spent", "problem_invoices", "problem_rate"]).default("spent"),
  },
  async run(args, { data }) {
    const rows = await data.invoices({ vendor: args.vendor, ...dateRange(args.date_field, args.from, args.to) });
    const byVendor = Map.groupBy(
      rows.filter((r) => r.vendor),
      (r) => r.vendor!,
    );
    const unreadable = rows.length - [...byVendor.values()].reduce((n, list) => n + list.length, 0);
    if (!byVendor.size) return { vendors: [], message: "No invoices from a named vendor in this period." };

    const payments = await data.payments(rows.filter((r) => r.vendor).map((r) => r.id));
    const vendors = [...byVendor].map(([vendor, list]) => summarizeVendor(vendor, list, payments));
    const key = { spent: "spentValue", problem_invoices: "problem_invoices", problem_rate: "rateValue" } as const;
    vendors.sort((a, b) => b[key[args.sort_by]] - a[key[args.sort_by]] || b.problem_invoices - a.problem_invoices);

    return {
      period: args.from || args.to ? `${args.date_field.replace("_", " ")} ${args.from ?? "start"} to ${args.to ?? "today"}` : "all time",
      vendor_count: vendors.length,
      vendors: vendors.slice(0, MAX_VENDORS).map(({ spentValue, rateValue, ...shown }) => shown),
      ...(unreadable && { unreadable_files_without_vendor: unreadable }),
      ...(payments == null && { note: "Paid/unpaid isn't available yet: the payments table isn't set up." }),
    };
  },
});

function summarizeVendor(vendor: string, list: Invoice[], payments: Payment[] | null) {
  const spent = payableTotal(list);
  const problems = list.filter((r) => r.status !== "clean").length;
  const paid = payments
    ? list.filter((r) => r.status !== "rejected").reduce((sum, r) => sum + Math.min(paidAmount(r, payments), Number(r.total ?? 0)), 0)
    : null;
  return {
    vendor,
    invoices: list.length,
    total_spent: money(spent),
    paid: paid == null ? "n/a" : money(paid),
    unpaid: paid == null ? "n/a" : money(spent - paid),
    problem_invoices: problems,
    problem_rate: percent(problems / list.length, 1),
    spentValue: spent,
    rateValue: problems / list.length,
  };
}
