# 60-second demo script (screen recording)

**Before recording**
- Terminal font size 16+, window about 120 columns wide, dark theme.
- Run `npm run seed:recon` so the statements match the current data.
- Pick a flagged invoice to approve: `npm run tool -- search_invoices status=flagged`. These steps use HLP-17296; use another one if it's already approved.
- Each answer takes 5–20 seconds. Record at normal speed and **cut the waiting** in editing, keeping the `→ tool` lines on screen, because they're the point of `--verbose`.
- Start: `npm run chat -- --verbose`

| Time | Type this | Say this (voice-over or caption) |
|---|---|---|
| 0:00–0:05 | *(banner visible)* | "An AI agent for accounts payable. Claude plus 10 tools, on the same Supabase data as my n8n invoice agent and dashboard." |
| 0:05–0:14 | `Which invoices are flagged and waiting for review?` | "Verbose mode shows the agent thinking: Claude picks a tool, my code runs it, and the answer only uses what the tool returned." |
| 0:14–0:20 | `and which of those are over $5,000?` | "Follow-ups work. It reuses the earlier filters and adds one." |
| 0:20–0:27 | `Why was HLP-17296 flagged?` | "Flags are explained in plain English, in the same wording as the dashboard." |
| 0:27–0:42 | `Reconcile Summit Logistics' October statement.` | "Month-end reconciliation. The matching is exact rules in code, not AI: every difference gets a next step, and the balance difference is explained to the cent." |
| 0:42–0:49 | `Draft an email to Summit asking for the missing invoices.` | "The email is built from the reconciliation result. It's a draft; nothing is ever sent." |
| 0:49–0:58 | `Approve HLP-17296.` → type `y` → type a reason, e.g. `CFO signed off, engagement letter on file` | "Actions need a human. The program itself asks y/n and for a reason before anything changes." |
| 0:58–1:00 | `exit` | "Two modes, my Claude subscription locally or the API key for deployment, with the same tools and safety rules." |

**Optional extras for a longer cut:** `Reconcile the October bank statement.` (shows the swapped-digits catch), `What's overdue?`, `Show me what was approved or rejected this week and why.`
