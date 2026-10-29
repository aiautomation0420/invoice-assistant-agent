// Reconciliation matching: exact rules in code, no AI. Claude only explains the result.
//   Invoices match on invoice number; payments on reference, else on amount + date.
//   Amounts must agree within $0.01; dates within DATE_WINDOW_DAYS.
import type { Invoice, Payment } from "../data.ts";
import { money } from "../shared/format.ts";

export const DATE_WINDOW_DAYS = 3;

export type StatementLine = {
  date: string;
  type: "invoice" | "payment" | "credit" | "opening_balance" | "closing_balance";
  reference: string;
  description: string;
  amount: number; // positive; payments and credits reduce the balance
};

export type BankLine = { date: string; description: string; reference: string; amount: number }; // negative = money out

export type VendorDifference = {
  kind: "missing_in_our_records" | "missing_from_their_statement" | "amount_difference" | "unapplied_payment" | "rejected_by_us";
  line_type: "invoice" | "payment" | "credit";
  reference: string;
  date: string | null;
  ours: number | null;
  theirs: number | null;
  /** How much this item makes THEIR balance higher than ours (negative = lower). */
  effect: number;
  action: string;
};

export type BankDifference = {
  kind: "not_yet_cleared" | "unexplained_bank_item" | "amount_difference" | "date_difference";
  reference: string;
  description: string;
  our_date: string | null;
  bank_date: string | null;
  ours: number | null;
  bank: number | null;
  action: string;
};

const sameAmount = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-9;
const round = (n: number) => Math.round(n * 100) / 100;
const sum = (list: number[]) => round(list.reduce((a, b) => a + b, 0));
const norm = (ref: string | null | undefined) => (ref ?? "").toUpperCase().replace(/\s+/g, "");
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Vendor statement vs our records for that vendor.
 * `invoices`: ALL of the vendor's invoices (so a statement line dated outside the period still finds its match).
 * `payments`: our payments to the vendor with paid_date inside the statement period.
 * Assumes the opening balance was agreed last month, so the closing difference is explained by this period's items.
 */
export function reconcileVendor(vendor: string, lines: StatementLine[], invoices: Invoice[], payments: Payment[]) {
  const opening = lines.find((l) => l.type === "opening_balance")?.amount ?? 0;
  const closingLine = lines.find((l) => l.type === "closing_balance");
  const items = lines.filter((l) => l.type !== "opening_balance" && l.type !== "closing_balance");
  const from = lines.find((l) => l.type === "opening_balance")?.date ?? items.map((l) => l.date).sort()[0];
  const to = closingLine?.date ?? items.map((l) => l.date).sort().at(-1)!;

  const differences: VendorDifference[] = [];
  const matched: { type: string; reference: string; amount: number }[] = [];
  const usedInvoices = new Set<string>();
  const usedPayments = new Set<string>();
  let rounding = 0; // matches within $0.01 still move the balance by that cent

  for (const line of items.filter((l) => l.type === "invoice")) {
    const candidates = invoices.filter((inv) => !usedInvoices.has(inv.id) && norm(inv.invoice_number) === norm(line.reference));
    const inv = candidates.find((c) => c.status !== "rejected") ?? candidates[0];
    if (!inv) {
      differences.push({
        kind: "missing_in_our_records", line_type: "invoice", reference: line.reference, date: line.date, ours: null, theirs: line.amount, effect: line.amount,
        action: `Ask ${vendor} for a copy of ${line.reference} (${money(line.amount)}, dated ${line.date}), then check whether it was received and why it isn't in our records.`,
      });
      continue;
    }
    usedInvoices.add(inv.id);
    const ours = Number(inv.total ?? 0);
    if (inv.status === "rejected") {
      differences.push({
        kind: "rejected_by_us", line_type: "invoice", reference: line.reference, date: line.date, ours: null, theirs: line.amount, effect: line.amount,
        action: `We rejected ${line.reference}${inv.review_note ? ` (${inv.review_note})` : ""}. Tell ${vendor} and ask them to remove it or issue a credit memo.`,
      });
    } else if (sameAmount(ours, line.amount)) {
      matched.push({ type: "invoice", reference: line.reference, amount: line.amount });
      rounding += line.amount - ours;
    } else {
      const diff = round(line.amount - ours);
      differences.push({
        kind: "amount_difference", line_type: "invoice", reference: line.reference, date: line.date, ours, theirs: line.amount, effect: diff,
        action: `Compare ${line.reference} with the original invoice: we have ${money(ours)}, ${vendor} shows ${money(line.amount)} (${diff > 0 ? "+" : ""}${money(diff)}). Ask for a corrected invoice or a credit memo.`,
      });
    }
  }

  // Our invoices for the period that their statement doesn't list.
  for (const inv of invoices) {
    if (usedInvoices.has(inv.id) || inv.status === "rejected" || !inv.invoice_date || inv.invoice_date < from || inv.invoice_date > to) continue;
    const ours = Number(inv.total ?? 0);
    differences.push({
      kind: "missing_from_their_statement", line_type: "invoice", reference: inv.invoice_number ?? inv.id, date: inv.invoice_date, ours, theirs: null, effect: -ours,
      action: `Send ${vendor} a copy of ${inv.invoice_number ?? "this invoice"} (${money(ours)}, dated ${inv.invoice_date}) and ask whether it's in their system. It could be a duplicate or an invoice they never issued.`,
    });
  }

  for (const line of items.filter((l) => l.type === "payment" || l.type === "credit")) {
    const byRef = line.type === "payment" && norm(line.reference) ? payments.find((p) => !usedPayments.has(p.payment_id) && norm(p.reference) === norm(line.reference)) : undefined;
    const p =
      byRef ??
      (line.type === "payment"
        ? payments.find((x) => !usedPayments.has(x.payment_id) && sameAmount(Number(x.amount), line.amount) && Math.abs(daysBetween(x.paid_date, line.date)) <= DATE_WINDOW_DAYS)
        : undefined);
    if (!p) {
      differences.push({
        kind: "missing_in_our_records", line_type: line.type as "payment" | "credit", reference: line.reference || line.description, date: line.date, ours: null, theirs: line.amount, effect: -line.amount,
        action:
          line.type === "credit"
            ? `Ask ${vendor} for credit memo ${line.reference || ""} (${money(line.amount)}) and record it.`
            : `${vendor} shows a payment of ${money(line.amount)} on ${line.date} that we have no record of. Check whether it was paid outside AP, then record it.`,
      });
      continue;
    }
    usedPayments.add(p.payment_id);
    const ours = Number(p.amount);
    if (sameAmount(ours, line.amount)) {
      matched.push({ type: "payment", reference: p.reference ?? p.payment_id, amount: ours });
      rounding -= line.amount - ours;
    } else {
      const diff = round(line.amount - ours);
      differences.push({
        kind: "amount_difference", line_type: "payment", reference: p.reference ?? p.payment_id, date: line.date, ours, theirs: line.amount, effect: -diff,
        action: `${vendor} applied ${money(line.amount)} for payment ${p.reference}, but we paid ${money(ours)}. Send them the remittance details and ask them to correct it.`,
      });
    }
  }

  for (const p of payments) {
    if (usedPayments.has(p.payment_id)) continue;
    differences.push({
      kind: "unapplied_payment", line_type: "payment", reference: p.reference ?? p.payment_id, date: p.paid_date, ours: Number(p.amount), theirs: null, effect: Number(p.amount),
      action: `Send ${vendor} the remittance for ${p.reference ?? p.payment_id} (${money(Number(p.amount))}, paid ${p.paid_date}${p.method ? ` by ${p.method}` : ""}) and ask them to apply it.`,
    });
  }

  const expected = invoices.filter((inv) => inv.status !== "rejected" && inv.invoice_date && inv.invoice_date >= from && inv.invoice_date <= to);
  const ourClosing = round(opening + sum(expected.map((i) => Number(i.total ?? 0))) - sum(payments.map((p) => Number(p.amount))));
  const theirComputed = round(opening + sum(items.filter((l) => l.type === "invoice").map((l) => l.amount)) - sum(items.filter((l) => l.type !== "invoice").map((l) => l.amount)));
  const theirClosing = closingLine?.amount ?? theirComputed;
  const difference = round(theirClosing - ourClosing);
  const explained = round(sum(differences.map((d) => d.effect)) + rounding);

  return {
    vendor,
    period: { from, to },
    opening_balance: opening,
    their_closing_balance: theirClosing,
    our_closing_balance: ourClosing,
    difference,
    explained,
    rounding: round(rounding),
    unexplained: round(difference - explained),
    statement_math_off_by: round(theirClosing - theirComputed),
    matched,
    differences,
  };
}

/**
 * Bank statement vs our payments. `payments`: our payments with paid_date inside the period (up to the statement date).
 * Withdrawals match a payment on reference (then amount and date are checked), else on amount within $0.01 and date within the window.
 */
export function reconcileBank(lines: BankLine[], payments: Payment[]) {
  const withdrawals = lines.filter((l) => l.amount < 0);
  const used = new Set<string>();
  const matched: { reference: string; amount: number; our_date: string; bank_date: string }[] = [];
  const differences: BankDifference[] = [];
  const who = (p: Payment) => p.vendor ?? "the vendor";

  for (const line of withdrawals) {
    const out = round(-line.amount);
    let p = norm(line.reference) ? payments.find((x) => !used.has(x.payment_id) && norm(x.reference) === norm(line.reference)) : undefined;
    if (p) {
      used.add(p.payment_id);
      const days = daysBetween(p.paid_date, line.date);
      const ours = Number(p.amount);
      if (!sameAmount(ours, out)) {
        const diff = round(out - ours);
        differences.push({
          kind: "amount_difference", reference: line.reference, description: line.description, our_date: p.paid_date, bank_date: line.date, ours, bank: out,
          action: `The bank took ${money(out)} for ${line.reference} to ${who(p)}, but we recorded ${money(ours)} (${diff > 0 ? "+" : ""}${money(diff)}). Check the payment record for a typo such as swapped digits; if the bank amount is right, correct our record, otherwise ask the bank.`,
        });
      } else if (Math.abs(days) > DATE_WINDOW_DAYS) {
        differences.push({
          kind: "date_difference", reference: line.reference, description: line.description, our_date: p.paid_date, bank_date: line.date, ours, bank: out,
          action: `${line.reference} to ${who(p)} cleared ${Math.abs(days)} days ${days > 0 ? "after" : "before"} the payment date we recorded (${p.paid_date}). ${p.method === "CHECK" ? "Normal for a mailed check, but confirm the check date." : "Unusual for an electronic payment: confirm the real payment date and correct our record."}`,
        });
      } else matched.push({ reference: line.reference, amount: out, our_date: p.paid_date, bank_date: line.date });
      continue;
    }
    p = payments
      .filter((x) => !used.has(x.payment_id) && sameAmount(Number(x.amount), out) && Math.abs(daysBetween(x.paid_date, line.date)) <= DATE_WINDOW_DAYS)
      .sort((a, b) => Math.abs(daysBetween(a.paid_date, line.date)) - Math.abs(daysBetween(b.paid_date, line.date)))[0];
    if (p) {
      used.add(p.payment_id);
      matched.push({ reference: p.reference ?? p.payment_id, amount: out, our_date: p.paid_date, bank_date: line.date });
      continue;
    }
    differences.push({
      kind: "unexplained_bank_item", reference: line.reference, description: line.description, our_date: null, bank_date: line.date, ours: null, bank: out,
      action: `Find out what "${line.description}" (${money(out)} on ${line.date}) is for: look for a payment that was never recorded, or ask the bank. Record it once you know.`,
    });
  }

  for (const p of payments) {
    if (used.has(p.payment_id)) continue;
    differences.push({
      kind: "not_yet_cleared", reference: p.reference ?? p.payment_id, description: `${p.method ?? "Payment"} to ${who(p)}`, our_date: p.paid_date, bank_date: null, ours: Number(p.amount), bank: null,
      action: `${p.method === "CHECK" ? "Outstanding check" : "Payment"} ${p.reference ?? p.payment_id} (${money(Number(p.amount))}, paid ${p.paid_date}) hasn't cleared yet. Normal for recent payments; if it's still open after 5 business days, check with the bank${p.method === "CHECK" ? " or the vendor" : ""}.`,
    });
  }

  const total = (kind: BankDifference["kind"], field: "ours" | "bank") => sum(differences.filter((d) => d.kind === kind).map((d) => d[field] ?? 0));
  return {
    matched,
    differences,
    totals: {
      not_yet_cleared: total("not_yet_cleared", "ours"),
      unexplained_bank_items: total("unexplained_bank_item", "bank"),
      amount_differences_net: round(total("amount_difference", "bank") - total("amount_difference", "ours")),
    },
    deposits_ignored: lines.length - withdrawals.length,
  };
}
