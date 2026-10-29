import { z } from "zod";
import { saveReport } from "../recon/files.ts";
import { bankRecon } from "../recon/run.ts";
import { money } from "../shared/format.ts";
import { defineTool } from "./common.ts";

const LABELS = {
  not_yet_cleared: "Paid by us, not yet cleared the bank",
  unexplained_bank_item: "Bank withdrawal with no matching payment",
  amount_difference: "Amount differs",
  date_difference: "Cleared well outside the payment date",
} as const;

export default defineTool({
  name: "reconcile_bank_statement",
  description:
    "Reconcile a bank statement CSV against our recorded payments for one month. Matching is done in code with exact rules " +
    "(reference, else amount within $0.01 and date within 3 days). Returns matched payments, payments not yet cleared, unexplained bank " +
    "withdrawals, amount differences and date differences, each with a suggested action. Report these results as they are; don't re-match. " +
    "Set save_report=true to also save a CSV report in reports/.",
  input: {
    file: z.string().min(1).max(200).describe("Statement file name from list_statement_files, e.g. bank-statement-2026-10.csv"),
    month: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM").optional().describe("Month to reconcile, YYYY-MM. Can be left out when the file covers one month."),
    save_report: z.boolean().default(false).describe("true = also save the result as a CSV report"),
  },
  async run({ file, month, save_report }, { data }) {
    const r = await bankRecon(data, file, month);
    const result = {
      month: r.month,
      period: `${r.period.from} to ${r.period.to}`,
      matched: { count: r.matched.length, total: money(r.matched.reduce((s, m) => s + m.amount, 0)) },
      differences_count: Object.fromEntries(Object.keys(LABELS).map((k) => [k, r.differences.filter((d) => d.kind === k).length])),
      differences: r.differences.map((d) => ({
        issue: LABELS[d.kind],
        reference: d.reference || "—",
        description: d.description,
        our_date: d.our_date ?? "—",
        bank_date: d.bank_date ?? "—",
        ours: d.ours == null ? "—" : money(d.ours),
        bank: d.bank == null ? "—" : money(d.bank),
        suggested_action: d.action,
      })),
      totals: {
        not_yet_cleared: money(r.totals.not_yet_cleared),
        unexplained_bank_withdrawals: money(r.totals.unexplained_bank_items),
        amount_differences_net: money(r.totals.amount_differences_net),
      },
      ...(r.deposits_ignored > 0 && { note: `${r.deposits_ignored} deposits were left out: this reconciliation covers AP payments only.` }),
      ...(r.warning && { warning: r.warning }),
    };
    if (!save_report) return { ...result, report: "Not saved. Call again with save_report=true to save a CSV." };
    const path = saveReport(`bank-recon-${r.month}`, [
      ["Bank statement reconciliation", r.month, result.period, `File: ${r.file}`],
      [],
      ["Result", "Reference", "Description", "Our date", "Bank date", "Our amount", "Bank amount", "Suggested action"],
      ...r.differences.map((d) => [LABELS[d.kind], d.reference, d.description, d.our_date ?? "", d.bank_date ?? "", d.ours?.toFixed(2) ?? "", d.bank?.toFixed(2) ?? "", d.action]),
      ...r.matched.map((m) => ["Matched", m.reference, "", m.our_date, m.bank_date, m.amount.toFixed(2), m.amount.toFixed(2), ""]),
    ]);
    return { ...result, report: `Saved to ${path}` };
  },
});
