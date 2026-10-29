// npm run eval            (asks before it starts; add -- --yes to skip the question)
// Asks Claude ~13 real questions and checks two things for each: did it call the expected tool, and does the answer
// contain the key fact. The expected facts come from running the same tools directly (no AI) on the current data and
// from samples/planted-differences.json, so they stay right after re-seeding.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Usage } from "../src/agent.ts";
import { supabaseData } from "../src/data.ts";
import { MODEL, PROVIDER_NAME, createProvider } from "../src/providers/index.ts";
import { friendly } from "../src/safety.ts";
import { FLAG_LABELS } from "../src/shared/config.ts";
import { weekStart, dateKey } from "../src/shared/week.ts";
import { today, type Context } from "../src/tools/common.ts";
import { runTool } from "../src/tools/index.ts";

const ROOT = join(import.meta.dirname, "..");
// The eval never approves anything: every y/n is answered "no".
const ctx: Context = { data: supabaseData(), confirm: async () => false, ask: async () => "" };

/** A fact is a string the answer must contain, or a list of alternatives (any one is enough). Case-insensitive. */
type Fact = string | string[];
type Case = { name: string; ask: string[]; tools: string[]; facts: Fact[] };

async function truth(name: string, input: object): Promise<any> {
  const { ok, result } = await runTool(name, input, ctx);
  if (!ok) throw new Error(`Couldn't work out the expected answer with ${name}: ${JSON.stringify(result)}`);
  return result;
}

// Words Claude may use instead of the exact flag label.
const FLAG_WORDS: Record<string, string[]> = {
  math_mismatch: ["math", "add up"], duplicate: ["duplicate"], unknown_vendor: ["vendor list", "approved vendor", "unknown vendor"],
  po_mismatch: ["PO"], over_approval_limit: ["approval limit"], missing_fields: ["missing"], unreadable_file: ["read the file", "unreadable"],
  due_date_before_invoice_date: ["due date"], low_confidence: ["confiden"],
};
const flagFact = (code: string) => [FLAG_LABELS[code] ?? code, ...(FLAG_WORDS[code] ?? [])];
const codeOf = (label: string) => Object.entries(FLAG_LABELS).find(([, l]) => l === label)?.[0] ?? label;
const none = ["no ", "none", "nothing", "0 "];

async function buildCases(): Promise<Case[]> {
  const day = today();
  const monthStart = `${day.slice(0, 7)}-01`;
  const thisMonday = dateKey(weekStart(Date.now()));

  const flagged = await truth("search_invoices", { status: "flagged" });
  const big = await truth("search_invoices", { status: "flagged", min_total: 5000 });
  const first = flagged.invoices?.[0];
  const detail = first ? await truth("get_invoice", { invoice: first.invoice_number }) : null;
  const summit = await truth("vendor_summary", { vendor: "Summit", from: monthStart, to: day });
  const week = await truth("weekly_report", {});
  const problems = await truth("vendor_summary", { sort_by: "problem_invoices" });
  const overdue = await truth("search_invoices", { overdue: true });
  const errors = await truth("list_errors", { limit: 1 });
  const reviewed = await truth("search_invoices", { date_field: "reviewed", from: thisMonday, to: day, reviewed_by: "anyone" });

  const cases: Case[] = [
    { name: "Flagged invoices", ask: ["Which invoices are flagged and waiting for review?"], tools: ["search_invoices"], facts: flagged.matches ? [flagged.total_amount_excluding_rejected] : [none] },
    {
      name: "Follow-up: over $5,000",
      ask: ["Which invoices are flagged and waiting for review?", "and which of those are over $5,000?"],
      tools: ["search_invoices"],
      facts: big.matches ? [big.invoices[0].invoice_number] : [none],
    },
    ...(first ? [{ name: "Why was it flagged", ask: [`Why was invoice ${first.invoice_number} flagged?`], tools: ["get_invoice"], facts: [flagFact(detail.invoices[0].flags[0].code)] }] : []),
    { name: "Spend with a vendor", ask: ["How much did we spend with Summit Logistics this month?"], tools: ["vendor_summary", "search_invoices"], facts: [summit.vendors?.[0]?.total_spent ?? none] },
    { name: "Top problem reasons", ask: ["What were the top problem reasons last week?"], tools: ["weekly_report"], facts: week.flag_reasons.length ? [flagFact(codeOf(week.flag_reasons[0].reason))] : [none] },
    { name: "Most problem vendors", ask: ["Which vendors send the most problem invoices?"], tools: ["vendor_summary"], facts: [problems.vendors[0].vendor] },
    { name: "Overdue", ask: ["What's overdue?"], tools: ["search_invoices"], facts: overdue.matches ? [[overdue.total_amount_excluding_rejected, `${overdue.matches} overdue`, `${overdue.matches} invoices`]] : [none] },
    { name: "Workflow errors", ask: ["Have there been any workflow errors recently?"], tools: ["list_errors"], facts: errors.errors?.length ? [errors.errors[0].step] : [none] },
    { name: "Unknown invoice (no inventing)", ask: ["Why was invoice INV-99999 flagged?"], tools: ["get_invoice"], facts: [["not found", "no invoice", "couldn't find", "could not find", "wasn't found", "doesn't exist", "does not exist", "no record", "isn't in"]] },
    {
      name: "Reviewed this week + why",
      ask: ["Show me what was approved or rejected this week and why."],
      tools: ["search_invoices"],
      facts: reviewed.matches ? [reviewed.invoices[0].invoice_number] : [none],
    },
  ];

  const keyFile = join(ROOT, "samples", "planted-differences.json");
  if (!existsSync(keyFile)) {
    console.log("No samples/planted-differences.json: skipping the reconciliation questions (run npm run seed:recon).");
    return cases;
  }
  const planted = JSON.parse(readFileSync(keyFile, "utf8"));
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${planted.month}-01T00:00:00Z`));
  const vendor = planted.vendor_statements[0];
  const missing = vendor.differences.find((d: any) => d.kind === "missing_in_our_records").reference;
  const bankFact = (d: any) => (d.kind === "unexplained_bank_item" ? [d.reference, "Rapid Print"] : d.reference);
  cases.push(
    { name: "Reconcile vendor statement", ask: [`Reconcile ${vendor.vendor}' ${monthName} statement.`], tools: ["reconcile_vendor_statement"], facts: vendor.differences.map((d: any) => d.reference) },
    { name: "Reconcile bank statement", ask: [`Reconcile the ${monthName} bank statement.`], tools: ["reconcile_bank_statement"], facts: planted.bank_statement.differences.map(bankFact) },
    { name: "Draft email (missing invoices)", ask: [`Draft an email to ${vendor.vendor.split(" ")[0]} asking for the missing invoices from their ${monthName} statement.`], tools: ["draft_vendor_email"], facts: [missing] },
  );
  return cases;
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────
const cases = await buildCases();
const warning =
  PROVIDER_NAME === "claude-code"
    ? `This asks Claude ${cases.length} questions (${cases.reduce((n, c) => n + c.ask.length, 0)} messages) using YOUR CLAUDE SUBSCRIPTION. It counts toward your usage limits.`
    : `This asks Claude ${cases.length} questions with ANTHROPIC_API_KEY. It costs money (with ${MODEL}, roughly a few cents in total).`;
console.log(`\n⚠  ${warning}`);
if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Continue? (y/n) ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) process.exit(0);
}

type Row = { name: string; tool: boolean; fact: boolean; called: string[]; missing: string[]; seconds: number; usage: Usage; cost?: number; error?: string };
const rows: Row[] = [];
for (const [i, c] of cases.entries()) {
  process.stdout.write(`${String(i + 1).padStart(2)}. ${c.name} … `);
  const called: string[] = [];
  const started = Date.now();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost: number | undefined;
  let text = "";
  let error: string | undefined;
  try {
    const provider = createProvider(ctx); // fresh conversation for every case
    for (const question of c.ask) {
      const answer = await provider.ask(question, { onToolCall: (name) => called.push(name) });
      text = answer.text;
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += answer.usage[k];
      if (answer.costUsd != null) cost = (cost ?? 0) + answer.costUsd;
    }
  } catch (err) {
    error = friendly(err, "eval");
  }
  const lower = text.toLowerCase();
  const missing = c.facts.filter((f) => !(Array.isArray(f) ? f : [f]).some((alt) => lower.includes(alt.toLowerCase()))).map((f) => (Array.isArray(f) ? f.join(" / ") : f));
  const row = { name: c.name, tool: c.tools.some((t) => called.includes(t)), fact: !error && missing.length === 0, called, missing, seconds: (Date.now() - started) / 1000, usage, cost, error };
  rows.push(row);
  console.log(row.tool && row.fact ? "PASS" : "FAIL");
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────
const tick = (ok: boolean) => (ok ? "✅" : "❌");
const passed = rows.filter((r) => r.tool && r.fact).length;
const totalCost = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
const table = [
  "| # | Question | Expected tool called | Key fact in answer | Result | Time |",
  "|---|---|---|---|---|---|",
  ...rows.map((r, i) => `| ${i + 1} | ${cases[i].ask.join(" → ")} | ${tick(r.tool)} ${r.called.join(", ") || "none"} | ${tick(r.fact)}${r.missing.length ? ` missing: ${r.missing.join("; ")}` : ""}${r.error ? ` ${r.error}` : ""} | ${r.tool && r.fact ? "PASS" : "FAIL"} | ${r.seconds.toFixed(1)}s |`),
].join("\n");
const summary = `**${passed}/${rows.length} passed** · ${PROVIDER_NAME} · ${MODEL} · ${today()}${PROVIDER_NAME === "anthropic-api" ? ` · est. $${totalCost.toFixed(3)}` : ""}`;

console.log(`\n${table}\n\n${summary}`);
mkdirSync(join(ROOT, "docs"), { recursive: true });
writeFileSync(join(ROOT, "docs", "eval-results.md"), `# Eval results\n\n${summary}\n\n${table}\n\nRun with \`npm run eval\`. Facts are computed from the current data and samples/planted-differences.json.\n`);
console.log("Saved to docs/eval-results.md");
process.exitCode = passed === rows.length ? 0 : 1;
