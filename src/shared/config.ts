// Copied from invoice-dashboard/lib/config.ts. Keep in sync: all 3 projects use the same rules.
// One place for the settings you may want to change.

/** Manual minutes one invoice takes a bookkeeper. Keep in sync with the n8n invoice workflow. */
export const MINUTES_PER_INVOICE = 6;

/** Invoices above this total need a human approval (bookkeeper check "over approval limit"). */
export const APPROVAL_LIMIT = 5_000;

/** Time zone used for every date and time on the site. */
export const TIME_ZONE = "Asia/Manila";

export const PORTFOLIO_URL = "https://lovergil-perillo-portfolio.vercel.app";

export const STATUSES = ["clean", "flagged", "approved", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

/** Codes the n8n workflow writes into invoices.flag_reasons, and how the site shows them. */
export const FLAG_LABELS: Record<string, string> = {
  math_mismatch: "Math mismatch",
  duplicate: "Possible duplicate",
  unknown_vendor: "Unknown vendor",
  po_mismatch: "PO mismatch",
  over_approval_limit: "Over approval limit",
  missing_fields: "Missing fields",
  unreadable_file: "Could not read file",
  due_date_before_invoice_date: "Due date before invoice date",
  low_confidence: "Low AI confidence",
};

/** One-line explanation of each check, shown on the invoice page and How it works. */
export const FLAG_HELP: Record<string, string> = {
  math_mismatch: "The line items, subtotal, tax and total don't add up.",
  duplicate: "Another invoice already has the same vendor, invoice number and total.",
  unknown_vendor: "The vendor isn't on the approved vendor list.",
  po_mismatch: "The PO number wasn't found, or the PO amount doesn't match the invoice total.",
  over_approval_limit: `The total is above the $${APPROVAL_LIMIT.toLocaleString("en-US")} approval limit, so a person must sign off.`,
  missing_fields: "The invoice number, invoice date, due date or total is missing.",
  unreadable_file: "The AI couldn't read the file (for example a blurry scan or a password-protected PDF).",
  due_date_before_invoice_date: "The due date is earlier than the invoice date, which usually means a misread date.",
  low_confidence: "The AI wasn't sure about one or more main fields (vendor, invoice number, date or total).",
};
