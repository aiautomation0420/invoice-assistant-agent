// Builds demo payments + sample statements from the CURRENT invoices, with planted differences.
// Pure function (no database), so tests can check the matching finds every planted difference.
import type { Invoice, Payment } from "../data.ts";
import { toCsv } from "../shared/report.ts";
import { daysBetween, DATE_WINDOW_DAYS } from "./match.ts";

export type SeedInvoice = Pick<Invoice, "id" | "vendor" | "invoice_number" | "invoice_date" | "due_date" | "total" | "status">;
export type NewPayment = Payment & { is_demo: true };
export type PlantedItem = { kind: string; reference: string; ours?: number; theirs?: number; bank?: number };

const VENDOR_COUNT = 3;
const PREFERRED_VENDOR = "Summit Logistics"; // the vendor in the example questions
const UNEXPLAINED_PAYEE = "RAPID PRINT CO"; // a sender in the demo data that isn't an approved vendor

/** Small seeded random generator, so the same invoices + month give the same files. */
export function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const clamp = (day: string, lo: string, hi: string) => (day < lo ? lo : day > hi ? hi : day);
const round = (n: number) => Math.round(n * 100) / 100;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fixed = (n: number) => n.toFixed(2);

/** 1203.00 -> 1230.00: the classic swapped-digits typo. */
export function swapDigits(value: number) {
  const s = String(Math.round(value * 100));
  for (let i = s.length - 4; i >= 0; i--) {
    if (s[i] !== s[i + 1]) return Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)) / 100;
  }
  return round(value + 9);
}

export function buildRecon(invoices: SeedInvoice[], options: { month: string; today: string; random?: () => number }) {
  const r = options.random ?? seeded(options.month);
  const int = (min: number, max: number) => min + Math.floor(r() * (max - min + 1));
  const shuffle = <T,>(list: T[]) => list.map((v) => [r(), v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const from = `${options.month}-01`;
  const monthEnd = addDays(addDays(from, 32).slice(0, 8) + "01", -1);
  const to = options.today < monthEnd ? options.today : monthEnd; // statements run to today for the current month
  if (to < from) throw new Error(`${options.month} hasn't started yet.`);
  const inPeriod = (day: string | null) => !!day && day >= from && day <= to;
  const randomDay = (lo = from, hi = to) => addDays(lo, int(0, Math.max(0, daysBetween(lo, hi))));

  // ── 1. Payments: most older invoices are paid; about 60% of those due this month ───────────────
  const payable = invoices
    .filter((i) => (i.status === "clean" || i.status === "approved") && i.vendor && i.invoice_number && Number(i.total) > 0 && i.invoice_date && i.due_date && i.invoice_date <= to)
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!) || a.id.localeCompare(b.id));
  const payments: NewPayment[] = [];
  const pay = (inv: SeedInvoice, paidDate: string) => {
    const n = payments.length + 1;
    const roll = r();
    const method = roll < 0.75 ? "ACH" : roll < 0.95 ? "CHECK" : "WIRE";
    const reference = method === "ACH" ? `ACH${options.month.replace("-", "")}${String(n).padStart(4, "0")}` : method === "CHECK" ? `CHK-${10400 + n}` : `WIRE-${options.month}-${n}`;
    payments.push({
      payment_id: `PAY-${options.month.replace("-", "")}-${String(n).padStart(4, "0")}`,
      invoice_id: inv.id, vendor: inv.vendor, amount: round(Number(inv.total)), paid_date: paidDate, method, reference, is_demo: true,
    });
  };
  for (const inv of payable) {
    const due = inv.due_date!;
    if (due < from) {
      if (r() < 0.92) pay(inv, clamp(addDays(due, -int(0, 5)), inv.invoice_date!, addDays(from, -1)));
    } else if (due <= addDays(to, 7) && r() < 0.6) {
      pay(inv, clamp(addDays(due, -int(0, 6)), inv.invoice_date! > from ? inv.invoice_date! : from, to));
    }
  }

  // ── 2. Vendor statements for the 3 most active vendors this period ──────────────────────────────
  const periodInvoices = (vendor: string) =>
    invoices.filter((i) => i.vendor === vendor && i.status !== "rejected" && inPeriod(i.invoice_date)).sort((a, b) => a.invoice_date!.localeCompare(b.invoice_date!));
  const vendors = [...new Set(invoices.map((i) => i.vendor).filter((v): v is string => !!v))]
    // every invoice needs a number and total, otherwise it can't appear on a statement
    .filter((v) => periodInvoices(v).length >= 3 && periodInvoices(v).every((i) => i.invoice_number && i.total != null))
    .sort((a, b) => Number(b === PREFERRED_VENDOR) - Number(a === PREFERRED_VENDOR) || periodInvoices(b).length - periodInvoices(a).length || a.localeCompare(b))
    .slice(0, VENDOR_COUNT);
  if (!vendors.length) throw new Error(`No vendor has 3 or more invoices dated in ${options.month}. Re-seed the dashboard or pick another month (--month YYYY-MM).`);

  const vendorPaymentsInPeriod = (vendor: string) => payments.filter((p) => p.vendor === vendor && inPeriod(p.paid_date));
  for (const vendor of vendors) {
    // Each statement needs 2+ payments this period: one they applied, one they didn't.
    while (vendorPaymentsInPeriod(vendor).length < 2) {
      const older = payments.find((p) => p.vendor === vendor && p.paid_date < from);
      if (older) {
        older.paid_date = randomDay(from, to > from ? addDays(to, -1) : to);
        continue;
      }
      const paidIds = new Set(payments.map((p) => p.invoice_id));
      const unpaid = payable.find((i) => i.vendor === vendor && !paidIds.has(i.id));
      if (!unpaid) break;
      pay(unpaid, randomDay(unpaid.invoice_date! > from ? unpaid.invoice_date! : from, to));
    }
  }

  const vendorStatements = vendors.flatMap((vendor) => {
    const ours = periodInvoices(vendor);
    const ourPayments = vendorPaymentsInPeriod(vendor);
    if (ours.length < 2 || ourPayments.length < 2) return [];
    const [missing, changed] = shuffle(ours);
    const [unapplied] = shuffle(ourPayments);
    const delta = [25, 75, 125, 210.5][int(0, 3)];

    // An invoice number in the vendor's own style that we don't have.
    const prefix = (missing.invoice_number!.match(/^\D*/) ?? [""])[0];
    const highest = Math.max(...invoices.filter((i) => i.invoice_number?.startsWith(prefix)).map((i) => Number(i.invoice_number!.slice(prefix.length)) || 0));
    const fakeNumber = `${prefix}${highest + int(30, 90)}`;
    const fake = { date: randomDay(), amount: round(300 + r() * 2200) };

    const theirInvoices = [
      ...ours.filter((i) => i !== missing).map((i) => ({ date: i.invoice_date!, reference: i.invoice_number!, amount: i === changed ? round(Number(i.total) + delta) : round(Number(i.total)) })),
      { date: fake.date, reference: fakeNumber, amount: fake.amount },
    ];
    const theirPayments = ourPayments.filter((p) => p !== unapplied);
    const opening = round(1000 + r() * 4000);
    const closing = round(opening + theirInvoices.reduce((s, l) => s + l.amount, 0) - theirPayments.reduce((s, p) => s + p.amount, 0));
    const rows = [
      { date: from, type: "opening_balance", reference: "", description: "Balance brought forward", amount: opening },
      ...[
        ...theirInvoices.map((l) => ({ ...l, type: "invoice", description: "Invoice" })),
        ...theirPayments.map((p) => ({ date: p.paid_date, type: "payment", reference: p.reference!, description: `Payment received - ${p.method}`, amount: p.amount })),
      ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type)),
      { date: to, type: "closing_balance", reference: "", description: "Balance due", amount: closing },
    ];
    const differences: PlantedItem[] = [
      { kind: "missing_in_our_records", reference: fakeNumber, theirs: fake.amount },
      { kind: "missing_from_their_statement", reference: missing.invoice_number!, ours: round(Number(missing.total)) },
      { kind: "amount_difference", reference: changed.invoice_number!, ours: round(Number(changed.total)), theirs: round(Number(changed.total) + delta) },
      { kind: "unapplied_payment", reference: unapplied.reference!, ours: unapplied.amount },
    ];
    return [{
      vendor,
      file: `vendor-statement-${slug(vendor)}-${options.month}.csv`,
      csv: toCsv([["date", "type", "reference", "description", "amount"], ...rows.map((l) => [l.date, l.type, l.reference, l.description, fixed(l.amount)])]),
      expected_balance_difference: round(fake.amount - Number(missing.total) + delta + unapplied.amount),
      differences,
    }];
  });

  // ── 3. Bank statement: every payment this period, with 4 planted differences ───────────────────
  const periodPayments = payments.filter((p) => inPeriod(p.paid_date)).sort((a, b) => a.paid_date.localeCompare(b.paid_date) || a.payment_id.localeCompare(b.payment_id));
  if (periodPayments.length < 4) throw new Error(`Only ${periodPayments.length} payments in ${options.month}; the bank statement needs at least 4.`);
  const notCleared = periodPayments.at(-1)!;
  const late = periodPayments
    .filter((p) => p !== notCleared && daysBetween(p.paid_date, to) > DATE_WINDOW_DAYS)
    .sort((a, b) => Number(b.method === "CHECK") - Number(a.method === "CHECK") || a.paid_date.localeCompare(b.paid_date))[0];
  const typo = shuffle(periodPayments.filter((p) => p !== notCleared && p !== late))[0];
  const amounts = periodPayments.map((p) => p.amount);
  let unknown = round(250 + r() * 400);
  while (amounts.some((a) => Math.abs(a - unknown) < 0.02)) unknown = round(unknown + 1.37);

  const describe = (p: NewPayment) =>
    p.method === "CHECK" ? `CHECK ${p.reference!.replace("CHK-", "")} ${p.vendor!.toUpperCase()}` : `${p.method === "WIRE" ? "WIRE OUT" : "ACH DEBIT"} ${p.vendor!.toUpperCase()}`;
  const bankRows = periodPayments
    .filter((p) => p !== notCleared)
    .map((p) => {
      const normal = clamp(addDays(p.paid_date, p.method === "CHECK" ? int(2, 3) : p.method === "ACH" ? 1 : 0), p.paid_date, to);
      const date = p === late ? addDays(p.paid_date, Math.min(9, daysBetween(p.paid_date, to))) : normal;
      return { date, description: describe(p), reference: p.reference!, amount: -(p === typo ? swapDigits(p.amount) : p.amount) };
    });
  const unknownRow = { date: randomDay(), description: `ACH DEBIT ${UNEXPLAINED_PAYEE}`, reference: "", amount: -unknown };
  bankRows.push(unknownRow);
  bankRows.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));

  const bankDifferences: PlantedItem[] = [
    { kind: "not_yet_cleared", reference: notCleared.reference!, ours: notCleared.amount },
    { kind: "unexplained_bank_item", reference: unknownRow.description, bank: unknown },
    { kind: "amount_difference", reference: typo.reference!, ours: typo.amount, bank: swapDigits(typo.amount) },
    ...(late ? [{ kind: "date_difference", reference: late.reference!, ours: late.amount }] : []),
  ];

  return {
    period: { from, to },
    payments,
    vendorStatements,
    bankStatement: {
      file: `bank-statement-${options.month}.csv`,
      csv: toCsv([["date", "description", "reference", "amount"], ...bankRows.map((l) => [l.date, l.description, l.reference, fixed(l.amount)])]),
      differences: bankDifferences,
    },
  };
}
