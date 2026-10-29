// npm run seed:recon [-- --month 2026-10]
// Rebuilds demo payments and the sample statements from the CURRENT demo invoices (run it again after the dashboard's npm run seed).
// Uses the secret key. Only touches demo payments (is_demo = true) and the generated files in samples/.
import { createClient } from "@supabase/supabase-js";
import { readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildRecon, type SeedInvoice } from "../src/recon/seed-data.ts";
import { redact } from "../src/safety.ts";
import { today } from "../src/tools/common.ts";

const SAMPLES = join(import.meta.dirname, "..", "samples");
const monthArg = process.argv[process.argv.indexOf("--month") + 1];
const month = process.argv.includes("--month") ? monthArg : today().slice(0, 7);

function fail(message: string): never {
  console.error(`\n${redact(message)}`);
  process.exit(1);
}

if (!/^\d{4}-\d{2}$/.test(month ?? "")) fail("Use --month YYYY-MM, for example --month 2026-10.");
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) fail("seed:recon needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env (it writes demo payments).");
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// 1. Current demo invoices.
const invoices: SeedInvoice[] = [];
for (let page = 0; ; page++) {
  const { data, error } = await db
    .from("invoices")
    .select("id, vendor, invoice_number, invoice_date, due_date, total, status")
    .eq("is_demo", true)
    .order("id")
    .range(page * 1000, page * 1000 + 999);
  if (error) fail(`Couldn't read invoices: ${error.message}`);
  invoices.push(...(data as SeedInvoice[]));
  if (data.length < 1000) break;
}
if (!invoices.length) fail("There are no demo invoices. Run npm run seed in the dashboard project first.");

// 2. Build payments + statements (same function the tests use).
let built: ReturnType<typeof buildRecon>;
try {
  built = buildRecon(invoices, { month: month!, today: today() });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// 3. Replace the demo payments.
const removed = await db.from("payments").delete().eq("is_demo", true);
if (removed.error) {
  fail(removed.error.code === "PGRST205" ? "The payments table doesn't exist yet. Run supabase/payments.sql in the Supabase SQL Editor first." : `Couldn't clear demo payments: ${removed.error.message}`);
}
for (let i = 0; i < built.payments.length; i += 500) {
  const { error } = await db.from("payments").insert(built.payments.slice(i, i + 500));
  if (error) fail(`Couldn't save payments: ${error.message}`);
}

// 4. Write the sample statements and the answer key (planted differences), replacing older generated files.
mkdirSync(SAMPLES, { recursive: true });
for (const file of readdirSync(SAMPLES)) {
  if (/^(vendor-statement-.*|bank-statement-.*)\.csv$|^planted-differences\.json$/.test(file)) rmSync(join(SAMPLES, file));
}
for (const s of built.vendorStatements) writeFileSync(join(SAMPLES, s.file), s.csv + "\r\n");
writeFileSync(join(SAMPLES, built.bankStatement.file), built.bankStatement.csv + "\r\n");
const planted = {
  generated_at: new Date().toISOString(),
  month,
  period: built.period,
  note: "Every difference planted in the sample statements. Tests and the eval check that the reconciliation finds all of them.",
  vendor_statements: built.vendorStatements.map(({ csv, ...rest }) => rest),
  bank_statement: { file: built.bankStatement.file, differences: built.bankStatement.differences },
};
writeFileSync(join(SAMPLES, "planted-differences.json"), JSON.stringify(planted, null, 2) + "\n");

const inMonth = built.payments.filter((p) => p.paid_date >= built.period.from && p.paid_date <= built.period.to).length;
console.log(`Payments: ${built.payments.length} demo payments saved (${inMonth} in ${month}).`);
for (const s of built.vendorStatements) console.log(`Vendor statement: samples/${s.file} (${s.vendor}, ${s.differences.length} planted differences)`);
console.log(`Bank statement:   samples/${built.bankStatement.file} (${built.bankStatement.differences.length} planted differences)`);
console.log("Answer key:       samples/planted-differences.json");
