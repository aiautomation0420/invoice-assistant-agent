import assert from "node:assert/strict";
import { test } from "node:test";
import { FLAG_HELP } from "../src/shared/config.ts";
import { runTool } from "../src/tools/index.ts";
import { fakeData, invoice, noAnswer, noConfirm } from "./fake-data.ts";

const call = (name: string, input: unknown, data = fakeData([])) => runTool(name, input, { data, confirm: noConfirm, ask: noAnswer });

test("search_invoices filters, counts all matches, and leaves rejected out of the total", async () => {
  const data = fakeData([
    invoice({ status: "flagged", total: 6200, flag_reasons: ["over_approval_limit"] }),
    invoice({ status: "flagged", total: 300, flag_reasons: ["math_mismatch"] }),
    invoice({ status: "rejected", total: 900 }),
    invoice({ status: "clean", vendor: "Northwind Office Supply", total: 50 }),
  ]);
  const flagged = (await call("search_invoices", { status: "flagged" }, data)).result as any;
  assert.equal(flagged.matches, 2);
  assert.equal(flagged.total_amount_excluding_rejected, "$6,500.00");

  const followUp = (await call("search_invoices", { status: "flagged", min_total: 5000 }, data)).result as any;
  assert.equal(followUp.matches, 1);
  assert.deepEqual(followUp.invoices[0].flags, ["Over approval limit"]);

  const summit = (await call("search_invoices", { vendor: "summit" }, data)).result as any;
  assert.equal(summit.matches, 3);
  assert.equal(summit.total_amount_excluding_rejected, "$6,500.00");
});

test("search_invoices lists at most 25 but counts every match", async () => {
  const data = fakeData(Array.from({ length: 30 }, () => invoice()));
  const { result } = (await call("search_invoices", {}, data)) as any;
  assert.equal(result.matches, 30);
  assert.equal(result.invoices.length, 25);
  assert.match(result.note, /first 25/);
});

test("search_invoices date range is processed date in Manila time, both days included", async () => {
  const data = fakeData([
    invoice({ created_at: "2026-10-18T15:59:00Z" }), // Oct 18, 23:59 Manila
    invoice({ created_at: "2026-10-18T16:00:00Z" }), // Oct 19, 00:00 Manila
    invoice({ created_at: "2026-10-25T15:59:00Z" }), // Oct 25, 23:59 Manila
  ]);
  const { result } = (await call("search_invoices", { from: "2026-10-19", to: "2026-10-25" }, data)) as any;
  assert.equal(result.matches, 2);
});

test("date_field picks the printed invoice date or the due date instead of the processed date", async () => {
  const data = fakeData([
    invoice({ invoice_date: "2026-09-30", due_date: "2026-10-30", created_at: "2026-10-02T02:00:00Z" }),
    invoice({ invoice_date: "2026-10-05", due_date: "2026-11-04", created_at: "2026-10-06T02:00:00Z" }),
    invoice({ invoice_date: null, due_date: null, created_at: "2026-10-07T02:00:00Z" }),
  ]);
  const count = async (input: object) => ((await call("search_invoices", input, data)).result as any).matches;
  assert.equal(await count({ from: "2026-10-01", to: "2026-10-31" }), 3);
  assert.equal(await count({ date_field: "invoice_date", from: "2026-10-01", to: "2026-10-31" }), 1);
  assert.equal(await count({ date_field: "due_date", from: "2026-10-26", to: "2026-11-01" }), 1);
  const vendors = (await call("vendor_summary", { date_field: "invoice_date", from: "2026-10-01", to: "2026-10-31" }, data)).result as any;
  assert.equal(vendors.vendors[0].invoices, 1);
});

test("overdue: approved/clean past due date and not fully paid; says so when payments aren't tracked", async () => {
  const pastDue = invoice({ status: "approved", due_date: "2026-01-10", total: 400 });
  const paidPastDue = invoice({ status: "clean", due_date: "2026-01-10", total: 250 });
  const flaggedPastDue = invoice({ status: "flagged", due_date: "2026-01-10" });
  const notDue = invoice({ status: "clean", due_date: "2999-01-01" });
  const invoices = [pastDue, paidPastDue, flaggedPastDue, notDue];

  const untracked = (await call("search_invoices", { overdue: true }, fakeData(invoices, null))).result as any;
  assert.equal(untracked.matches, 2);
  assert.match(untracked.payments_note, /aren't tracked yet/);
  assert.ok(untracked.invoices[0].days_overdue > 0);

  const payment = { payment_id: "PAY-1", invoice_id: paidPastDue.id, vendor: "Summit Logistics", amount: 250, paid_date: "2026-01-09", method: "ACH", reference: null };
  const tracked = (await call("search_invoices", { overdue: true }, fakeData(invoices, [payment]))).result as any;
  assert.equal(tracked.matches, 1);
  assert.equal(tracked.invoices[0].invoice_number, pastDue.invoice_number);
  assert.equal(tracked.payments_note, undefined);
});

test("due-date searches list soonest due first; overdue lists most overdue first with days overdue", async () => {
  const data = fakeData([
    invoice({ due_date: "2026-10-28", created_at: "2026-10-01T02:00:00Z" }),
    invoice({ due_date: "2026-10-20", created_at: "2026-10-03T02:00:00Z" }),
    invoice({ due_date: "2026-10-27", created_at: "2026-10-02T02:00:00Z" }),
  ]);
  const due = (await call("search_invoices", { date_field: "due_date", from: "2026-10-01", to: "2026-10-31" }, data)).result as any;
  assert.deepEqual(due.invoices.map((i: any) => i.due_date), ["Oct 20, 2026", "Oct 27, 2026", "Oct 28, 2026"]);
  const overdue = (await call("search_invoices", { overdue: true }, data)).result as any;
  const days = overdue.invoices.map((i: any) => i.days_overdue);
  assert.ok(days[0] > days[1] && days[1] > days[2], `expected most overdue first, got ${days}`);
  assert.equal(days[0] - days[2], 8);
});

test("reviewed filter: 'approved or rejected this week and why' shows when, by whom and the note, latest first", async () => {
  const data = fakeData([
    invoice({ invoice_number: "A-1", status: "approved", reviewed_at: "2026-10-27T03:00:00Z", reviewed_by: "Invoice Assistant (CLI)", review_note: "CFO signed off" }),
    invoice({ invoice_number: "R-1", status: "rejected", reviewed_at: "2026-10-28T03:00:00Z", reviewed_by: null, review_note: null }),
    invoice({ invoice_number: "OLD", status: "approved", reviewed_at: "2026-10-10T03:00:00Z", reviewed_by: "Invoice Assistant (CLI)", review_note: "old" }),
    invoice({ invoice_number: "F-1", status: "flagged" }),
  ]);
  const week = (await call("search_invoices", { date_field: "reviewed", from: "2026-10-26", to: "2026-11-01", reviewed_by: "anyone" }, data)).result as any;
  assert.deepEqual(week.invoices.map((i: any) => i.invoice_number), ["R-1", "A-1"]);
  assert.equal(week.invoices[1].review_note, "CFO signed off");
  assert.equal(week.invoices[1].reviewed_by, "Invoice Assistant (CLI)");
  assert.equal(week.invoices[0].reviewed_by, "reviewer email (n8n)");
  assert.match(week.invoices[0].reviewed, /Oct 28, 2026/);

  const mine = (await call("search_invoices", { reviewed_by: "invoice_assistant" }, data)).result as any;
  assert.deepEqual(mine.invoices.map((i: any) => i.invoice_number), ["A-1", "OLD"]);
  const flagged = (await call("search_invoices", { status: "flagged" }, data)).result as any;
  assert.equal(flagged.invoices[0].review_note, undefined); // rows without a decision stay short
});

test("bad input goes back as an error Claude can read, instead of crashing", async () => {
  const bad = await call("search_invoices", { status: "paid", from: "2026-02-31" });
  assert.equal(bad.ok, false);
  assert.match((bad.result as any).error, /status/);
  assert.match((bad.result as any).error, /YYYY-MM-DD/);
  const unknown = await call("delete_everything", {});
  assert.match((unknown.result as any).error, /no tool called/);
});

test("get_invoice explains each flag with the dashboard wording and shows the math problem", async () => {
  const inv = invoice({
    invoice_number: "SUM-1042",
    status: "flagged",
    flag_reasons: ["math_mismatch", "low_confidence"],
    subtotal: 1000,
    tax: 0,
    total: 1100,
    confidence: { vendor: 0.97, invoice_number: 0.95, invoice_date: 0.62, total: 0.99 },
  });
  const { result } = (await call("get_invoice", { invoice: "sum-1042" }, fakeData([inv]))) as any;
  const [found] = result.invoices;
  assert.equal(found.flags[0].explanation, FLAG_HELP.math_mismatch);
  assert.equal(found.flags[1].label, "Low AI confidence");
  assert.deepEqual(found.math_problems, ["Subtotal + tax = $1,000.00, but the total says $1,100.00."]);
  assert.deepEqual(found.low_confidence_fields, ["invoice_date (62%)"]);
  assert.equal(found.payment_status, "Unpaid");
});

test("get_invoice payment status: paid, partly paid, not tracked, not found", async () => {
  const paid = invoice({ total: 500 });
  const partly = invoice({ total: 800 });
  const pay = (inv: { id: string }, amount: number) => ({
    payment_id: `PAY-${amount}`, invoice_id: inv.id, vendor: "Summit Logistics", amount, paid_date: "2026-10-22", method: "ACH", reference: "ACH-1",
  });
  const data = fakeData([paid, partly], [pay(paid, 500), pay(partly, 300)]);
  const status = async (ref: string, d = data) => ((await call("get_invoice", { invoice: ref }, d)).result as any).invoices[0].payment_status;
  assert.equal(await status(paid.invoice_number!), "Paid ($500.00)");
  assert.equal(await status(partly.invoice_number!), "Partly paid: $300.00 of $800.00");
  assert.match(await status(paid.invoice_number!, fakeData([paid], null)), /Not tracked yet/);
  const missing = (await call("get_invoice", { invoice: "INV-9999" }, data)).result as any;
  assert.equal(missing.found, false);
});

test("vendor_summary groups by vendor with problem rate and sorts by problem invoices", async () => {
  const data = fakeData([
    invoice({ status: "flagged" }),
    invoice({ status: "approved" }),
    invoice({ status: "clean", total: 4000 }),
    invoice({ vendor: "Northwind Office Supply", status: "clean", total: 9000 }),
    invoice({ vendor: null, status: "flagged", total: null, flag_reasons: ["unreadable_file"] }),
  ]);
  const { result } = (await call("vendor_summary", { sort_by: "problem_invoices" }, data)) as any;
  assert.equal(result.vendors[0].vendor, "Summit Logistics");
  assert.equal(result.vendors[0].problem_invoices, 2);
  assert.equal(result.vendors[0].problem_rate, "66.7%");
  assert.equal(result.vendors[0].total_spent, "$6,000.00");
  assert.equal(result.vendors[0].unpaid, "$6,000.00");
  assert.equal(result.unreadable_files_without_vendor, 1);
  const bySpent = (await call("vendor_summary", {}, data)).result as any;
  assert.equal(bySpent.vendors[0].vendor, "Northwind Office Supply");
});

test("weekly_report uses the dashboard rules for the chosen week vs the week before", async () => {
  const data = fakeData([
    invoice({ status: "clean", total: 100 }),
    invoice({ status: "flagged", total: 200, flag_reasons: ["duplicate", "po_mismatch"] }),
    invoice({ status: "rejected", total: 999, flag_reasons: ["duplicate"] }),
    invoice({ status: "clean", total: 50, created_at: "2026-10-13T02:00:00Z" }), // week before
  ]);
  const { result } = (await call("weekly_report", { week: "2026-10-21" }, data)) as any;
  assert.match(result.week, /^Oct 19\s–\s25, 2026$/); // Intl puts thin spaces around the dash
  const metric = (name: string) => result.metrics.find((m: any) => m.metric === name);
  assert.equal(metric("Invoices processed").this_week, "3");
  assert.equal(metric("Invoices processed").week_before, "1");
  assert.equal(metric("Flag rate").this_week, "66.7%");
  assert.equal(metric("Total amount (excl. rejected)").this_week, "$300.00");
  assert.equal(metric("Hours saved").this_week, "0.3 h");
  assert.deepEqual(result.flag_reasons[0], { reason: "Possible duplicate", this_week: 2, week_before: 0 });
});

test("update_invoice_status asks y/n with the dashboard money format and only changes on y", async () => {
  const inv = invoice({ invoice_number: "SUM-1042", status: "flagged", total: 2300 });
  const questions: string[] = [];
  const ask = (answer: boolean) => async (q: string) => (questions.push(q), answer);
  const data = fakeData([inv]);

  const no = (await runTool("update_invoice_status", { invoice: "SUM-1042", action: "approve" }, { data, confirm: ask(false), ask: noAnswer })).result as any;
  assert.equal(questions[0], "Approve SUM-1042 from Summit Logistics for $2,300.00?");
  assert.equal(no.done, false);
  assert.equal(inv.status, "flagged");

  const yes = (await runTool("update_invoice_status", { invoice: "SUM-1042", action: "approve" }, { data, confirm: ask(true), ask: noAnswer })).result as any;
  assert.equal(yes.done, true);
  assert.equal(inv.status, "approved");
});

test("review reason: required for rejections and over-limit approvals, optional otherwise, saved with the decision", async () => {
  const yes = async () => true;
  const answers = (...list: string[]) => {
    const asked: string[] = [];
    return { asked, ask: async (q: string) => (asked.push(q), list.shift() ?? "") };
  };
  const small = invoice({ invoice_number: "SUM-1", status: "flagged", total: 2300 });
  const big = invoice({ invoice_number: "HLP-1", status: "flagged", total: 10791.08 });
  const dup = invoice({ invoice_number: "BPK-1", status: "flagged", total: 900 });
  const data = fakeData([small, big, dup]);

  const optional = answers("");
  const a = (await runTool("update_invoice_status", { invoice: "SUM-1", action: "approve" }, { data, confirm: yes, ask: optional.ask })).result as any;
  assert.deepEqual(optional.asked, ["Reason (optional, press Enter to skip):"]);
  assert.equal(a.done, true);
  assert.equal(small.review_note, null);

  const noReason = answers("", "  ");
  const b = (await runTool("update_invoice_status", { invoice: "HLP-1", action: "approve" }, { data, confirm: yes, ask: noReason.ask })).result as any;
  assert.equal(noReason.asked.length, 2);
  assert.match(noReason.asked[0], /required/);
  assert.equal(b.done, false);
  assert.equal(big.status, "flagged");

  const withReason = answers("Signed off by CFO, engagement letter on file");
  const c = (await runTool("update_invoice_status", { invoice: "HLP-1", action: "approve" }, { data, confirm: yes, ask: withReason.ask })).result as any;
  assert.equal(c.done, true);
  assert.equal(big.review_note, "Signed off by CFO, engagement letter on file");
  assert.equal(big.reviewed_by, "Invoice Assistant (CLI)");

  const reject = answers("", "Duplicate of BPK-0");
  const d = (await runTool("update_invoice_status", { invoice: "BPK-1", action: "reject" }, { data, confirm: yes, ask: reject.ask })).result as any;
  assert.equal(d.done, true);
  assert.equal(dup.status, "rejected");
  assert.equal(dup.review_note, "Duplicate of BPK-0");

  const shown = (await runTool("get_invoice", { invoice: "BPK-1" }, { data, confirm: noConfirm, ask: noAnswer })).result as any;
  assert.equal(shown.invoices[0].review_note, "Duplicate of BPK-0");
  assert.equal(shown.invoices[0].reviewed_by, "Invoice Assistant (CLI)");
});

test("update_invoice_status refuses non-flagged and real invoices without asking", async () => {
  let asked = false;
  const confirm = async () => ((asked = true), true);
  const clean = invoice({ invoice_number: "SUM-1", status: "clean" });
  const real = invoice({ invoice_number: "SUM-2", status: "flagged", is_demo: false });
  const data = fakeData([clean, real]);
  const a = (await runTool("update_invoice_status", { invoice: "SUM-1", action: "reject" }, { data, confirm, ask: noAnswer })).result as any;
  assert.match(a.message, /already clean/);
  const b = (await runTool("update_invoice_status", { invoice: "SUM-2", action: "reject" }, { data, confirm, ask: noAnswer })).result as any;
  assert.match(b.message, /real \(non-demo\)/);
  assert.equal(asked, false);
  assert.equal(real.status, "flagged");
});

test("list_errors returns recent workflow errors", async () => {
  const data = fakeData([], [], [{ workflow: "AI Invoice Processing & Audit Agent", node: "AI Extraction (OpenRouter)", message: "Model response was not valid JSON", created_at: "2026-10-27T03:00:00Z" }]);
  const { result } = (await call("list_errors", {}, data)) as any;
  assert.equal(result.errors_last_7_days, 1);
  assert.equal(result.errors[0].step, "AI Extraction (OpenRouter)");
});

test("database failures become a friendly message without details", async () => {
  const broken = { ...fakeData([]), invoices: async () => { throw new Error("connection refused at db.secret-host:5432 key sb_secret_abc123"); } };
  const { ok, result } = await call("search_invoices", {}, broken);
  assert.equal(ok, false);
  assert.doesNotMatch((result as any).error, /secret|5432/);
  assert.match((result as any).error, /logs\/app\.log/);
});
