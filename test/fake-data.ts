// In-memory stand-in for Supabase, so tests run without a database or keys.
import type { Data, Invoice, Payment, WorkflowError } from "../src/data.ts";

let counter = 0;

export function invoice(overrides: Partial<Invoice> = {}): Invoice {
  counter++;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    vendor: "Summit Logistics",
    vendor_matched: "Summit Logistics",
    invoice_number: `SUM-${10000 + counter}`,
    invoice_date: "2026-10-15",
    due_date: "2026-11-14",
    currency: "USD",
    po_number: null,
    line_items: [{ description: "Freight - LTL", quantity: 1, unit_price: 1000, amount: 1000 }],
    subtotal: 1000,
    tax: 0,
    total: 1000,
    confidence: { vendor: 0.97, invoice_number: 0.95, invoice_date: 0.93, total: 0.99 },
    status: "clean",
    flag_reasons: [],
    source: "gmail",
    reviewed_at: null,
    created_at: "2026-10-20T02:00:00Z", // Tue Oct 20, 10:00 Manila (week of Oct 19)
    is_demo: true,
    ...overrides,
  };
}

export function fakeData(invoices: Invoice[], payments: Payment[] | null = [], errors: WorkflowError[] = []): Data {
  return {
    async invoices(q) {
      return invoices
        .filter(
          (r) =>
            (!q.status || r.status === q.status) &&
            (!q.vendor || (r.vendor ?? "").toLowerCase().includes(q.vendor.toLowerCase())) &&
            (q.createdFrom == null || Date.parse(r.created_at) >= q.createdFrom) &&
            (q.createdTo == null || Date.parse(r.created_at) < q.createdTo) &&
            (q.reviewedFrom == null || (r.reviewed_at != null && Date.parse(r.reviewed_at) >= q.reviewedFrom)) &&
            (q.reviewedTo == null || (r.reviewed_at != null && Date.parse(r.reviewed_at) < q.reviewedTo)) &&
            (q.reviewedBy !== "anyone" || r.reviewed_at != null) &&
            (q.reviewedBy !== "invoice_assistant" || r.reviewed_by === "Invoice Assistant (CLI)") &&
            (!q.dateColumn || !q.dateFrom || (r[q.dateColumn] ?? "") >= q.dateFrom) &&
            (!q.dateColumn || !q.dateTo || (r[q.dateColumn] != null && r[q.dateColumn]! <= q.dateTo)) &&
            (q.minTotal == null || Number(r.total) >= q.minTotal) &&
            (q.maxTotal == null || Number(r.total) <= q.maxTotal) &&
            (!q.flag || (r.flag_reasons ?? []).includes(q.flag)),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async invoicesByRef(ref) {
      return invoices.filter((r) => r.id === ref || r.invoice_number?.toLowerCase() === ref.toLowerCase());
    },
    async payments(ids) {
      return payments && payments.filter((p) => ids.includes(p.invoice_id));
    },
    async errors(limit) {
      return { rows: errors.slice(0, limit), lastWeek: errors.length };
    },
    canWrite: () => true,
    async paymentsIn(q) {
      if (!payments) return null;
      const vendor = q.vendor?.toLowerCase();
      return payments.filter((p) => p.paid_date >= q.from && p.paid_date <= q.to && (!vendor || (p.vendor ?? "").toLowerCase().includes(vendor)));
    },
    async setStatus(id, status, note) {
      const row = invoices.find((r) => r.id === id && r.status === "flagged" && r.is_demo);
      if (!row) return 0;
      Object.assign(row, { status, review_note: note, reviewed_by: "Invoice Assistant (CLI)", reviewed_at: new Date().toISOString() });
      return 1;
    },
  };
}

export const noConfirm = async () => false;
export const noAnswer = async () => "";
