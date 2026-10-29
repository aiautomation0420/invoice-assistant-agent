# Eval results

**13/13 passed** · claude-code · claude-sonnet-5-5 · 2026-10-29

| # | Question | Expected tool called | Key fact in answer | Result | Time |
|---|---|---|---|---|---|
| 1 | Which invoices are flagged and waiting for review? | ✅ search_invoices | ✅ | PASS | 8.4s |
| 2 | Which invoices are flagged and waiting for review? → and which of those are over $5,000? | ✅ search_invoices, search_invoices | ✅ | PASS | 13.6s |
| 3 | Why was invoice HLP-17296 flagged? | ✅ get_invoice | ✅ | PASS | 7.0s |
| 4 | How much did we spend with Summit Logistics this month? | ✅ vendor_summary | ✅ | PASS | 6.9s |
| 5 | What were the top problem reasons last week? | ✅ weekly_report | ✅ | PASS | 7.1s |
| 6 | Which vendors send the most problem invoices? | ✅ vendor_summary | ✅ | PASS | 9.5s |
| 7 | What's overdue? | ✅ search_invoices | ✅ | PASS | 13.0s |
| 8 | Have there been any workflow errors recently? | ✅ list_errors | ✅ | PASS | 7.9s |
| 9 | Why was invoice INV-99999 flagged? | ✅ get_invoice | ✅ | PASS | 7.1s |
| 10 | Show me what was approved or rejected this week and why. | ✅ search_invoices | ✅ | PASS | 7.1s |
| 11 | Reconcile Summit Logistics' October statement. | ✅ list_statement_files, reconcile_vendor_statement | ✅ | PASS | 10.8s |
| 12 | Reconcile the October bank statement. | ✅ list_statement_files, reconcile_bank_statement | ✅ | PASS | 8.6s |
| 13 | Draft an email to Summit asking for the missing invoices from their October statement. | ✅ list_statement_files, draft_vendor_email | ✅ | PASS | 8.4s |

Run with `npm run eval`. Facts are computed from the current data and samples/planted-differences.json.
