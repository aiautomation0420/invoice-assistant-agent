import { z } from "zod";
import { money, date, dateTime, sourceLabel } from "../shared/format.ts";
import { mathIssues } from "../shared/report.ts";
import { defineTool, flagDetails, paymentStatus } from "./common.ts";

const LOW_CONFIDENCE = 0.8; // same threshold as the low_confidence check

export default defineTool({
  name: "get_invoice",
  description:
    "Get one invoice by invoice number (e.g. 'SUM-10422') or id: all fields, line items, why it was flagged " +
    "(each flag with its plain-English explanation and the actual math that doesn't add up), low-confidence fields, payment status, and who reviewed it with their note. " +
    "If the same number belongs to several invoices (possible duplicates), all of them are returned.",
  input: {
    invoice: z.string().min(1).max(100).describe("Invoice number as printed, or the invoice id"),
  },
  async run({ invoice }, { data }) {
    const found = await data.invoicesByRef(invoice);
    if (!found.length) return { found: false, message: `No invoice "${invoice}" was found.` };
    const payments = await data.payments(found.map((inv) => inv.id));
    return {
      found: true,
      invoices: found.map((inv) => ({
        id: inv.id,
        invoice_number: inv.invoice_number ?? "(none)",
        vendor: inv.vendor ?? "(unreadable file)",
        approved_vendor_match: inv.vendor_matched ?? "none",
        invoice_date: date(inv.invoice_date),
        due_date: date(inv.due_date),
        po_number: inv.po_number ?? "none",
        line_items: (inv.line_items ?? []).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit_price: money(item.unit_price, inv.currency),
          amount: money(item.amount, inv.currency),
        })),
        subtotal: money(inv.subtotal, inv.currency),
        tax: money(inv.tax, inv.currency),
        total: money(inv.total, inv.currency),
        status: inv.status,
        flags: flagDetails(inv.flag_reasons),
        math_problems: mathIssues(inv),
        low_confidence_fields: Object.entries(inv.confidence ?? {})
          .filter(([, score]) => score < LOW_CONFIDENCE)
          .map(([field, score]) => `${field} (${Math.round(score * 100)}%)`),
        payment_status: paymentStatus(inv, payments),
        payments: (payments ?? [])
          .filter((p) => p.invoice_id === inv.id)
          .map((p) => ({ payment_id: p.payment_id, amount: money(p.amount, inv.currency), paid: date(p.paid_date), method: p.method, reference: p.reference })),
        source: sourceLabel(inv.source),
        processed: dateTime(inv.created_at),
        reviewed: dateTime(inv.reviewed_at),
        reviewed_by: inv.reviewed_by ?? "—",
        review_note: inv.review_note ?? "—",
      })),
    };
  },
});
