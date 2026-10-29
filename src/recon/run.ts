// Loads a statement file + our records, then runs the matching. Shared by the reconcile tools and draft_vendor_email.
import type { Data } from "../data.ts";
import { UserError } from "../safety.ts";
import { today } from "../tools/common.ts";
import { amount, isoDate, readRows } from "./files.ts";
import { reconcileBank, reconcileVendor, type StatementLine } from "./match.ts";

const LINE_TYPES = ["invoice", "payment", "credit", "opening_balance", "closing_balance"] as const;
const NO_PAYMENTS = "Payments aren't set up yet. Run supabase/payments.sql in Supabase, then npm run seed:recon.";
const STALE = "Almost nothing on this statement matches our records. If the dashboard's demo data was re-seeded, run npm run seed:recon to rebuild the sample statements.";

export async function vendorRecon(data: Data, file: string, vendor: string) {
  const lines = readRows<StatementLine>(file, ["date", "type", "reference", "description", "amount"], (r) => {
    const type = r.type.toLowerCase() as StatementLine["type"];
    if (!LINE_TYPES.includes(type)) throw new Error(`type "${r.type}" should be one of ${LINE_TYPES.join(", ")}`);
    return { date: isoDate(r.date), type, reference: r.reference, description: r.description, amount: Math.abs(amount(r.amount)) };
  });
  if (!lines.some((l) => l.type === "closing_balance")) throw new UserError(`"${file}" has no closing_balance row, so the balance can't be compared.`);

  const invoices = await data.invoices({ vendor });
  if (!invoices.length) throw new UserError(`No invoices from a vendor matching "${vendor}" were found in our records.`);
  // The most common matching name, e.g. "Summit" -> "Summit Logistics".
  const counts = Map.groupBy(invoices, (i) => i.vendor ?? "");
  const name = [...counts].sort((a, b) => b[1].length - a[1].length)[0][0];
  const own = counts.get(name)!;

  const dates = lines.map((l) => l.date).sort();
  const from = lines.find((l) => l.type === "opening_balance")?.date ?? dates[0];
  const to = lines.find((l) => l.type === "closing_balance")!.date;
  const payments = await data.paymentsIn({ vendor: name, from, to });
  if (payments == null) throw new UserError(NO_PAYMENTS);

  const result = reconcileVendor(name, lines, own, payments.filter((p) => p.vendor === name));
  const statementInvoices = lines.filter((l) => l.type === "invoice").length;
  const stale = statementInvoices >= 3 && result.matched.filter((m) => m.type === "invoice").length === 0;
  return { ...result, file, warning: stale ? STALE : undefined };
}

export async function bankRecon(data: Data, file: string, month?: string) {
  const rows = readRows(file, ["date", "description", "reference", "amount"], (r) => ({
    date: isoDate(r.date), description: r.description, reference: r.reference, amount: amount(r.amount),
  }));
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  const target = month ?? (months.length === 1 ? months[0] : undefined);
  if (!target) throw new UserError(`"${file}" covers ${months.join(", ")}. Say which month to reconcile.`);
  const lines = rows.filter((r) => r.date.startsWith(target));
  if (!lines.length) throw new UserError(`"${file}" has no lines in ${target}.`);

  const from = `${target}-01`;
  const monthEnd = new Date(Date.UTC(Number(target.slice(0, 4)), Number(target.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const to = today() < monthEnd ? today() : monthEnd; // statement date: the month end, or today for the current month
  const payments = await data.paymentsIn({ from, to });
  if (payments == null) throw new UserError(NO_PAYMENTS);

  const result = reconcileBank(lines, payments);
  const stale = lines.filter((l) => l.amount < 0).length >= 3 && result.matched.length === 0;
  return { ...result, file, month: target, period: { from, to }, warning: stale ? STALE : undefined };
}
