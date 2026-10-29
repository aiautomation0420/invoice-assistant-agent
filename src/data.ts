// Every Supabase read lives here. Tools only see the `Data` interface, so tests can pass a fake one.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Status } from "./shared/config.ts";
import { UserError } from "./safety.ts";

/** Which rows the agent sees. Default "demo": seeded rows only, read with the publishable key (same as the public dashboard). */
export type DataScope = "demo" | "real" | "all";
const scopeEnv = process.env.DATA_SCOPE;
export const DATA_SCOPE: DataScope = scopeEnv === "real" || scopeEnv === "all" ? scopeEnv : "demo";

export type LineItem = { description?: string; quantity?: number; unit_price?: number; amount?: number };

export type Invoice = {
  id: string;
  vendor: string | null;
  vendor_matched: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  po_number: string | null;
  line_items: LineItem[] | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  confidence: Record<string, number> | null;
  status: Status;
  flag_reasons: string[] | null;
  source: string | null;
  reviewed_at: string | null;
  /** Added by supabase/payments.sql. */
  review_note?: string | null;
  reviewed_by?: string | null;
  created_at: string;
  is_demo: boolean;
};

export type Payment = {
  payment_id: string;
  invoice_id: string;
  vendor: string | null;
  amount: number;
  paid_date: string;
  method: string | null;
  reference: string | null;
};

export type WorkflowError = { workflow: string | null; node: string | null; message: string | null; created_at: string };

/** Times are timestamps (ms); createdTo is excluded. Dates filter on created_at, like the dashboard. */
export type InvoiceQuery = {
  status?: Status;
  vendor?: string;
  createdFrom?: number;
  createdTo?: number;
  /** Decision time range (reviewed_at), ms; reviewedTo is excluded. */
  reviewedFrom?: number;
  reviewedTo?: number;
  /** "anyone" = any approve/reject decision; "invoice_assistant" = decisions made in this chat. */
  reviewedBy?: "anyone" | "invoice_assistant";
  /** Plain-date range on the printed invoice date or the due date, "YYYY-MM-DD", both days included. */
  dateColumn?: "invoice_date" | "due_date";
  dateFrom?: string;
  dateTo?: string;
  minTotal?: number;
  maxTotal?: number;
  flag?: string;
};

export type Data = {
  /** All matching invoices, newest first (at most 20,000). */
  invoices(q: InvoiceQuery): Promise<Invoice[]>;
  /** Invoices with this id or invoice number (case-insensitive). Several when a number is duplicated. */
  invoicesByRef(ref: string): Promise<Invoice[]>;
  /** Payments for these invoices, or null when the payments table isn't set up yet. */
  payments(invoiceIds: string[]): Promise<Payment[] | null>;
  /** Payments with paid_date in [from, to] ("YYYY-MM-DD", both included), optionally for one vendor. Null when the table isn't set up. */
  paymentsIn(q: { vendor?: string; from: string; to: string }): Promise<Payment[] | null>;
  /** Newest workflow errors, plus how many happened in the last 7 days. */
  errors(limit: number): Promise<{ rows: WorkflowError[]; lastWeek: number }>;
  /** True when the secret key is set, so approve/reject can run. */
  canWrite(): boolean;
  /** Approve/reject one invoice that is still flagged (and a demo row unless ALLOW_REAL_UPDATES). Returns rows changed: 0 or 1. */
  setStatus(id: string, status: "approved" | "rejected", note: string | null): Promise<number>;
};

/** Approving/rejecting real (non-demo) invoices is off unless you set ALLOW_REAL_UPDATES=true. */
export const ALLOW_REAL_UPDATES = process.env.ALLOW_REAL_UPDATES === "true";

/** Saved in invoices.reviewed_by when a decision is made in this chat. */
export const REVIEWED_BY = "Invoice Assistant (CLI)";

const PAGE = 1000; // Supabase returns at most 1000 rows per request
// shortcut: reads at most 20,000 invoices per question, same cap as the dashboard; move the math into SQL views before real volume gets near that.
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_COLUMNS = "payment_id, invoice_id, vendor, amount, paid_date, method, reference";
const LIST_COLUMNS =
  "id, vendor, vendor_matched, invoice_number, invoice_date, due_date, currency, total, status, flag_reasons, reviewed_at, reviewed_by, review_note, created_at, is_demo";

/** Keeps only characters that can't act as filter syntax or wildcards (same idea as the dashboard search). */
export function cleanText(text: string) {
  return text.replace(/[^\p{L}\p{N} .&#/'-]/gu, "").trim().slice(0, 100);
}

class MissingTable extends Error {}

type Response<T> = { data: T | null; error: { message: string; code?: string } | null; status?: number };

/** Runs one query, retrying twice with a short wait when Supabase is busy or times out. */
async function run<T>(what: string, query: () => PromiseLike<unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response<T>;
    try {
      res = (await query()) as Response<T>; // supabase-js has no table types here
    } catch (err) {
      if (err instanceof UserError) throw err; // e.g. missing key: nothing to retry
      res = { data: null, error: { message: String(err) }, status: 0 };
    }
    if (!res.error) return res.data as T;
    if (res.status === 401 || res.status === 403) {
      throw new UserError("Supabase rejected the key. Check SUPABASE_PUBLISHABLE_KEY (or SUPABASE_SECRET_KEY) in .env.");
    }
    if (res.error.code === "PGRST205" || res.error.code === "42P01") throw new MissingTable(what);
    if (res.error.code === "PGRST204" || res.error.code === "42703") {
      throw new UserError("The database is missing a column this needs. Run supabase/payments.sql in the Supabase SQL Editor, then try again.");
    }
    const busy = !res.status || res.status === 408 || res.status === 429 || res.status >= 500;
    if (!busy || attempt === 3) throw new Error(`${what} failed (HTTP ${res.status ?? "?"}): ${res.error.code ?? ""} ${res.error.message}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 700));
  }
}

function connect(key: string | undefined, missing: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  if (!url || !key) throw new UserError(missing);
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }) },
  });
}

export function supabaseData(): Data {
  // Connect on first use, so a missing key shows up as a friendly tool error.
  let reader: SupabaseClient | undefined;
  let writer: SupabaseClient | undefined; // secret key: only for approve/reject, after the user typed y
  const readKey = DATA_SCOPE === "demo" ? process.env.SUPABASE_PUBLISHABLE_KEY : process.env.SUPABASE_SECRET_KEY;
  const scoped = (table: string, columns: string) => {
    reader ??= connect(
      readKey,
      DATA_SCOPE === "demo"
        ? "Supabase isn't set up. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env (see .env.example)."
        : `DATA_SCOPE=${DATA_SCOPE} needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env.`,
    );
    const query = reader.from(table).select(columns);
    return DATA_SCOPE === "all" ? query : query.eq("is_demo", DATA_SCOPE === "demo");
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    async invoices(q) {
      const rows: Invoice[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await run<Invoice[]>("read invoices", () => {
          let query = scoped("invoices", LIST_COLUMNS);
          if (q.status) query = query.eq("status", q.status);
          if (q.vendor) query = query.ilike("vendor", `%${cleanText(q.vendor)}%`);
          if (q.createdFrom != null) query = query.gte("created_at", iso(q.createdFrom));
          if (q.createdTo != null) query = query.lt("created_at", iso(q.createdTo));
          if (q.reviewedFrom != null) query = query.gte("reviewed_at", iso(q.reviewedFrom));
          if (q.reviewedTo != null) query = query.lt("reviewed_at", iso(q.reviewedTo));
          if (q.reviewedBy === "anyone") query = query.not("reviewed_at", "is", null);
          if (q.reviewedBy === "invoice_assistant") query = query.eq("reviewed_by", REVIEWED_BY);
          if (q.dateColumn && q.dateFrom) query = query.gte(q.dateColumn, q.dateFrom);
          if (q.dateColumn && q.dateTo) query = query.lte(q.dateColumn, q.dateTo);
          if (q.minTotal != null) query = query.gte("total", q.minTotal);
          if (q.maxTotal != null) query = query.lte("total", q.maxTotal);
          if (q.flag) query = query.filter("flag_reasons", "cs", JSON.stringify([q.flag]));
          return query.order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
        });
        rows.push(...batch);
        if (batch.length < PAGE) break;
      }
      return rows;
    },

    async invoicesByRef(ref) {
      return run<Invoice[]>("read invoice", () => {
        const query = scoped("invoices", "*");
        return (UUID.test(ref) ? query.eq("id", ref) : query.ilike("invoice_number", cleanText(ref))).limit(5);
      });
    },

    async payments(invoiceIds) {
      const all: Payment[] = [];
      try {
        for (let i = 0; i < invoiceIds.length; i += 100) {
          const chunk = invoiceIds.slice(i, i + 100);
          all.push(
            ...(await run<Payment[]>("read payments", () =>
              scoped("payments", PAYMENT_COLUMNS).in("invoice_id", chunk),
            )),
          );
        }
      } catch (err) {
        if (err instanceof MissingTable) return null;
        throw err;
      }
      return all;
    },

    async paymentsIn(q) {
      try {
        return await run<Payment[]>("read payments", () => {
          let query = scoped("payments", PAYMENT_COLUMNS).gte("paid_date", q.from).lte("paid_date", q.to);
          if (q.vendor) query = query.ilike("vendor", `%${cleanText(q.vendor)}%`);
          return query.order("paid_date").limit(PAGE);
        });
      } catch (err) {
        if (err instanceof MissingTable) return null;
        throw err;
      }
    },

    async errors(limit) {
      const [rows, recent] = await Promise.all([
        run<WorkflowError[]>("read error_log", () =>
          scoped("error_log", "workflow, node, message, created_at").order("created_at", { ascending: false }).limit(limit),
        ),
        run<{ created_at: string }[]>("read error_log", () =>
          scoped("error_log", "created_at").gte("created_at", iso(Date.now() - 7 * 86_400_000)).limit(PAGE),
        ),
      ]);
      return { rows, lastWeek: recent.length };
    },

    canWrite: () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),

    async setStatus(id, status, note) {
      writer ??= connect(process.env.SUPABASE_SECRET_KEY, "Approving or rejecting needs SUPABASE_SECRET_KEY in .env (the publishable key is read-only).");
      const changed = await run<{ id: string }[]>("update invoice status", () => {
        // Only a row that is still flagged: if someone reviewed it a moment ago, nothing changes.
        const query = writer!.from("invoices").update({ status, reviewed_at: new Date().toISOString(), review_note: note, reviewed_by: REVIEWED_BY }).eq("id", id).eq("status", "flagged");
        return (ALLOW_REAL_UPDATES ? query : query.eq("is_demo", true)).select("id");
      });
      return changed.length;
    },
  };
}
