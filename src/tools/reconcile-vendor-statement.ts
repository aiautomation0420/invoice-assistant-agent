import { z } from "zod";
import { saveReport } from "../recon/files.ts";
import { vendorRecon } from "../recon/run.ts";
import { money } from "../shared/format.ts";
import { defineTool } from "./common.ts";

const LABELS = {
  missing_in_our_records: "On their statement, not in our records",
  missing_from_their_statement: "In our records, not on their statement",
  amount_difference: "Amount differs",
  unapplied_payment: "Payment we sent that they haven't applied",
  rejected_by_us: "On their statement, but we rejected it",
} as const;

export default defineTool({
  name: "reconcile_vendor_statement",
  description:
    "Reconcile a vendor's statement CSV against our invoices and payments for that vendor. Matching is done in code with exact rules " +
    "(invoice number; payments by reference, else amount within $0.01 and date within 3 days). Returns matched items, every difference " +
    "(missing in our records, missing from their statement, amount differences, unapplied payments) with a suggested action, and the balance " +
    "difference with how much the items explain. Report these results as they are; don't re-match. Set save_report=true to also save a CSV report in reports/.",
  input: {
    file: z.string().min(1).max(200).describe("Statement file name from list_statement_files, e.g. vendor-statement-summit-logistics-2026-10.csv"),
    vendor: z.string().min(1).max(100).describe("Vendor name or part of it, e.g. 'Summit'"),
    save_report: z.boolean().default(false).describe("true = also save the result as a CSV report"),
  },
  async run({ file, vendor, save_report }, { data }) {
    const r = await vendorRecon(data, file, vendor);
    const diffs = r.differences.map((d) => ({
      issue: LABELS[d.kind],
      type: d.line_type,
      reference: d.reference,
      date: d.date ?? "—",
      ours: d.ours == null ? "—" : money(d.ours),
      theirs: d.theirs == null ? "—" : money(d.theirs),
      suggested_action: d.action,
    }));
    const result = {
      vendor: r.vendor,
      period: `${r.period.from} to ${r.period.to}`,
      matched: { count: r.matched.length, items: r.matched.map((m) => `${m.type} ${m.reference} ${money(m.amount)}`) },
      differences_count: Object.fromEntries(Object.keys(LABELS).map((k) => [k, r.differences.filter((d) => d.kind === k).length])),
      differences: diffs,
      balance: {
        their_closing_balance: money(r.their_closing_balance),
        our_closing_balance: money(r.our_closing_balance),
        difference: money(r.difference),
        explained_by_the_differences: money(r.explained),
        ...(r.rounding !== 0 && { of_which_rounding: money(r.rounding) }),
        unexplained: money(r.unexplained),
        note: `Assumes the opening balance on their statement (${money(r.opening_balance)}) was agreed at last month's reconciliation.`,
      },
      ...(r.statement_math_off_by !== 0 && { statement_math_warning: `Their own lines don't add up to their closing balance (off by ${money(r.statement_math_off_by)}).` }),
      ...(r.warning && { warning: r.warning }),
    };
    if (!save_report) return { ...result, report: "Not saved. Call again with save_report=true to save a CSV." };
    const path = saveReport(`recon-${r.vendor}-${r.period.from.slice(0, 7)}`, [
      ["Vendor statement reconciliation", r.vendor, result.period, `File: ${r.file}`],
      [],
      ["Their closing balance", r.their_closing_balance.toFixed(2)],
      ["Our closing balance", r.our_closing_balance.toFixed(2)],
      ["Difference", r.difference.toFixed(2)],
      ["Explained by the differences below", r.explained.toFixed(2)],
      ["Unexplained", r.unexplained.toFixed(2)],
      [],
      ["Result", "Type", "Reference", "Date", "Our amount", "Their amount", "Suggested action"],
      ...r.differences.map((d) => [LABELS[d.kind], d.line_type, d.reference, d.date, d.ours?.toFixed(2) ?? "", d.theirs?.toFixed(2) ?? "", d.action]),
      ...r.matched.map((m) => ["Matched", m.type, m.reference, "", m.amount.toFixed(2), m.amount.toFixed(2), ""]),
    ]);
    return { ...result, report: `Saved to ${path}` };
  },
});
