// Reconciliation: build statements from fake invoices with planted differences, then check the matching finds exactly those.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Invoice } from "../src/data.ts";
import { parseCsv, readStatement } from "../src/recon/files.ts";
import { reconcileBank, reconcileVendor, type BankLine, type StatementLine } from "../src/recon/match.ts";
import { buildRecon, seeded, swapDigits } from "../src/recon/seed-data.ts";
import { runTool } from "../src/tools/index.ts";
import { fakeData, invoice, noAnswer, noConfirm } from "./fake-data.ts";

const VENDORS = [["Summit Logistics", "SUM"], ["Northwind Office Supply", "NW"], ["Crestline IT Services", "CIT"], ["Apex Cloud Hosting", "APX"]] as const;

/** ~5 months of invoices for 4 vendors, like the dashboard's demo data. */
function demoInvoices(seed: string) {
  const r = seeded(seed);
  const list: Invoice[] = [];
  let n = 100;
  for (let day = 0; day < 150; day++) {
    for (const [vendor, prefix] of VENDORS) {
      if (r() > 0.3) continue;
      const invoiceDate = new Date(Date.UTC(2026, 5, 1 + day)).toISOString().slice(0, 10);
      const due = new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + (r() < 0.5 ? 15 : 30) * 86_400_000).toISOString().slice(0, 10);
      const roll = r();
      list.push(invoice({
        vendor, invoice_number: `${prefix}-${17000 + n++}`, invoice_date: invoiceDate, due_date: due,
        total: Math.round((200 + r() * 4500) * 100) / 100,
        status: roll < 0.75 ? "clean" : roll < 0.85 ? "approved" : roll < 0.95 ? "flagged" : "rejected",
      }));
    }
  }
  return list;
}

const key = (d: { kind: string; reference: string }) => `${d.kind}|${d.reference}`;
const toLines = (csv: string) => parseCsv(csv).records;

for (const seed of ["2026-10", "alpha", "beta", "gamma"]) {
  test(`every planted difference is found, and nothing else (data set "${seed}")`, () => {
    const invoices = demoInvoices(seed);
    const built = buildRecon(invoices, { month: "2026-10", today: "2026-10-29", random: seeded(seed) });
    assert.equal(built.vendorStatements.length, 3);
    assert.equal(built.vendorStatements[0].vendor, "Summit Logistics");

    for (const statement of built.vendorStatements) {
      const lines: StatementLine[] = toLines(statement.csv).map((r) => ({ ...r, amount: Number(r.amount) }) as StatementLine);
      const payments = built.payments.filter((p) => p.vendor === statement.vendor && p.paid_date >= "2026-10-01" && p.paid_date <= "2026-10-29");
      const result = reconcileVendor(statement.vendor, lines, invoices.filter((i) => i.vendor === statement.vendor), payments);
      assert.deepEqual(result.differences.map(key).sort(), statement.differences.map(key).sort(), statement.vendor);
      assert.equal(result.unexplained, 0, `${statement.vendor}: balance difference fully explained`);
      assert.equal(result.difference, statement.expected_balance_difference);
      assert.equal(result.statement_math_off_by, 0);
      assert.ok(result.matched.length >= 2);
      for (const d of result.differences) assert.ok(d.action.length > 20, "every difference has a suggested action");
    }

    const bankLines: BankLine[] = toLines(built.bankStatement.csv).map((r) => ({ ...r, amount: Number(r.amount) }) as BankLine);
    const periodPayments = built.payments.filter((p) => p.paid_date >= "2026-10-01" && p.paid_date <= "2026-10-29");
    const bank = reconcileBank(bankLines, periodPayments);
    const bankKey = (d: { kind: string; reference: string; description?: string }) => `${d.kind}|${d.kind === "unexplained_bank_item" ? d.description : d.reference}`;
    assert.deepEqual(bank.differences.map(bankKey).sort(), built.bankStatement.differences.map(key).sort());
    assert.equal(built.bankStatement.differences.length, 4);
    assert.ok(bank.matched.length >= 3);
  });
}

test("matching rules: amount within $0.01, payments by reference, else amount + date within 3 days", () => {
  const inv = invoice({ vendor: "Summit Logistics", invoice_number: "SUM-1", invoice_date: "2026-10-05", total: 100 });
  const pay = (id: string, amount: number, paid_date: string, reference: string | null = null) => ({ payment_id: id, invoice_id: inv.id, vendor: "Summit Logistics", amount, paid_date, method: "ACH", reference });
  const lines: StatementLine[] = [
    { date: "2026-10-01", type: "opening_balance", reference: "", description: "", amount: 0 },
    { date: "2026-10-05", type: "invoice", reference: "sum-1", description: "", amount: 100.01 }, // case + 1 cent: still a match
    { date: "2026-10-10", type: "payment", reference: "", description: "", amount: 50 }, // no ref: matched on amount + date (2 days)
    { date: "2026-10-20", type: "payment", reference: "", description: "", amount: 70 }, // 5 days off: not a match
    { date: "2026-10-31", type: "closing_balance", reference: "", description: "", amount: -19.99 },
  ];
  const r = reconcileVendor("Summit Logistics", lines, [inv], [pay("P1", 50, "2026-10-08"), pay("P2", 70, "2026-10-15")]);
  assert.deepEqual(r.matched.map((m) => m.type), ["invoice", "payment"]);
  assert.deepEqual(r.differences.map((d) => d.kind).sort(), ["missing_in_our_records", "unapplied_payment"]);
  assert.equal(r.unexplained, 0);
});

test("an invoice we rejected but the vendor still bills is called out", () => {
  const rejected = invoice({ vendor: "Summit Logistics", invoice_number: "SUM-9", invoice_date: "2026-10-05", total: 400, status: "rejected", review_note: "Duplicate of SUM-8" });
  const lines: StatementLine[] = [
    { date: "2026-10-05", type: "invoice", reference: "SUM-9", description: "", amount: 400 },
    { date: "2026-10-31", type: "closing_balance", reference: "", description: "", amount: 400 },
  ];
  const r = reconcileVendor("Summit Logistics", lines, [rejected], []);
  assert.equal(r.differences[0].kind, "rejected_by_us");
  assert.match(r.differences[0].action, /Duplicate of SUM-8/);
  assert.equal(r.unexplained, 0);
});

test("swapDigits makes the classic transposition typo", () => {
  assert.equal(swapDigits(1203), 1230);
  assert.equal(swapDigits(4538.71), 4583.71);
  assert.equal(swapDigits(2222), 2231);
});

test("statement files: only .csv inside the statements folder; clear message for missing files and wrong format", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-"));
  process.env.STATEMENTS_DIR = dir;
  try {
    writeFileSync(join(dir, "good.csv"), "date,type,reference,description,amount\r\n2026-10-31,closing_balance,,,0\r\n");
    writeFileSync(join(dir, "bad.csv"), "when,what\r\n2026-10-01,x\r\n");
    writeFileSync(join(dir, "notes.txt"), "hello");
    assert.match(readStatement("good.csv"), /closing_balance/);
    assert.throws(() => readStatement("../package.json"), /statements folder/);
    assert.throws(() => readStatement("C:/Windows/win.ini"), /statements folder/);
    assert.throws(() => readStatement("notes.txt"), /Only \.csv/);
    assert.throws(() => readStatement("nope.csv"), /wasn't found\. Available files: bad\.csv, good\.csv/);
    try {
      symlinkSync(join(import.meta.dirname, "..", "package.json"), join(dir, "link.csv"));
      assert.throws(() => readStatement("link.csv"), /links outside/);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err; // Windows needs admin rights for symlinks
    }
    const ctx = { data: fakeData([invoice()]), confirm: noConfirm, ask: noAnswer };
    const wrong = (await runTool("reconcile_vendor_statement", { file: "bad.csv", vendor: "Summit" }, ctx)).result as any;
    assert.match(wrong.error, /isn't in the expected format.*missing: date, type, reference, description, amount/);
    const escape = (await runTool("reconcile_bank_statement", { file: "../../secrets.csv" }, ctx)).result as any;
    assert.match(escape.error, /statements folder/);
  } finally {
    delete process.env.STATEMENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile tools + draft_vendor_email work end to end on generated files (fake database)", async () => {
  const invoices = demoInvoices("tools");
  const built = buildRecon(invoices, { month: "2026-10", today: "2026-10-29", random: seeded("tools") });
  const dir = mkdtempSync(join(tmpdir(), "recon-"));
  process.env.STATEMENTS_DIR = dir;
  try {
    for (const s of built.vendorStatements) writeFileSync(join(dir, s.file), s.csv);
    const ctx = { data: fakeData(invoices, built.payments), confirm: noConfirm, ask: noAnswer };
    const summit = built.vendorStatements[0];
    const r = (await runTool("reconcile_vendor_statement", { file: summit.file, vendor: "Summit" }, ctx)).result as any;
    assert.equal(r.vendor, "Summit Logistics");
    assert.equal(r.balance.unexplained, "$0.00");
    assert.deepEqual(Object.values(r.differences_count), [1, 1, 1, 1, 0]);

    const email = (await runTool("draft_vendor_email", { vendor: "Summit", statement_file: summit.file, include: ["missing_in_our_records"] }, ctx)).result as any;
    const missing = summit.differences.find((d) => d.kind === "missing_in_our_records")!;
    assert.equal(email.sent, false);
    assert.match(email.body, new RegExp(missing.reference));
    assert.doesNotMatch(email.body, /Payments we sent/);
  } finally {
    delete process.env.STATEMENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
