# Invoice Assistant Agent

**An AI agent for accounts payable: a Windows desktop app, a web app, and a terminal chat.** Ask it about invoices in plain English, approve or reject flagged ones (with a y/n confirmation and a reason), and reconcile vendor and bank statements the way an AP team does, with exact matching rules in code and Claude explaining the results.

Part 3 of my automation portfolio → [lovergil-perillo-portfolio.vercel.app](https://lovergil-perillo-portfolio.vercel.app)

```
You: Reconcile Summit Logistics' October statement.
  → list_statement_files {}
  → reconcile_vendor_statement {"file":"vendor-statement-summit-logistics-2026-10.csv","vendor":"Summit"}

Assistant: 30 items matched, 4 differences:
| Issue                                   | Reference      | Ours       | Theirs     | Suggested action                         |
| Amount differs                          | SUM-17163      | $11,646.81 | $11,771.81 | Ask for a corrected invoice or credit memo |
| On their statement, not in our records  | SUM-17248      | —          | $1,996.41  | Ask for a copy of the invoice            |
| In our records, not on their statement  | SUM-17166      | $3,989.52  | —          | Send a copy and ask if it's in their system |
| Payment they haven't applied            | ACH2026100183  | $826.06    | —          | Send the remittance and ask them to apply it |
Balance: theirs $23,620.80, ours $24,662.85, difference -$1,042.05: fully explained, $0.00 unexplained.
```

## Why it's useful for an AP team

I'm a bookkeeper (accounts payable and receivable). The questions this agent answers are the ones I get every day:

- **"Which invoices are waiting for me, and why were they flagged?"** The agent explains each flag in plain English and shows the actual math that doesn't add up.
- **"How much do we owe Summit, and what's overdue?"** Overdue means approved for payment, past the due date and not fully paid, worked out from real payment records.
- **"Does the vendor's statement agree with our books?"** Month-end reconciliation usually means two spreadsheets side by side for an hour. Here it takes seconds, and every difference comes with the next step ("Ask Summit for a copy of SUM-17248").
- **"Draft the email to the vendor."** The items come straight from the reconciliation, so nothing is retyped and nothing is made up.

It never invents numbers. Every amount, invoice and reconciliation result comes from a tool that read the database or the statement file.

## Web app

`npm run app` opens it at **http://localhost:3210**. It uses the same agent, tools and safety rules as the terminal chat:

- **Agent steps panel:** the GUI version of `--verbose`. Each tool call appears live, with its input, its result and the token use. You can turn it off.
- **Real dialogs for decisions:** approving or rejecting opens a confirmation dialog, then a reason box (required for rejections and invoices over $5,000). The program asks these questions, not Claude. Closing the tab counts as "no".
- **Cards for results you act on:** email drafts with a Copy button (marked *Not sent*), and saved reconciliation reports with **Download CSV**.
- **Same look as the dashboard:** Inter, black/white/gray, the same status colors, light and dark mode, keyboard and screen-reader friendly, and it works on a phone.
- **Local only:** it listens on 127.0.0.1, rejects requests from other websites (Host and Origin checks), and has a strict Content-Security-Policy. Answers are escaped before they're formatted.

## Desktop app (Windows)

`npm run desktop:build` builds `dist/InvoiceAssistant-Setup-0.1.0.exe`, an installer with a Start-menu and Desktop icon. The app is built with Electron: it runs the same local server inside the app, on a free port on 127.0.0.1, and shows it in its own window. Same agent, tools and safety rules.

- **Settings live outside the installer.** On first launch the app creates `%APPDATA%Invoice Assistant.env` and asks you to fill in your Supabase values. Keys are never packaged; the build includes only `desktop/`, `src/`, `web/`, `samples/` and `.env.example`, and it was checked for key values.
- **Logs and saved reports** go to the same app-data folder (*File → Open reports folder*).
- **Locked-down window:** no Node access in the page (context isolation, sandbox), it can't be navigated away from the app, and any other link opens in your normal browser.
- **One window:** opening it a second time brings back the window that's already open.
- **Subscription mode** needs Claude Code logged in on that computer. **API mode** needs `AI_PROVIDER=anthropic-api` and a key in the settings file.
- **Unsigned:** the installer isn't code-signed, so Windows SmartScreen shows "Unknown publisher" (*More info → Run anyway*). Signing needs a paid certificate.
- **Statements:** the installer bundles the sample statements from the time of the build. After `npm run seed:recon`, rebuild, or set `STATEMENTS_DIR` in the app's settings file to the project's `samples` folder.
- `npm run desktop` runs the desktop app straight from the project, without installing.

## How it connects to my other two projects

```
                                 ┌──────────────────────────────── Supabase (Postgres) ──────────────────────────────┐
Gmail / Drive ─► 1. n8n: AI Invoice Processing & Audit Agent ─► │ invoices · run_log · error_log · vendors · purchase_orders · payments (new) │
                  extract → 9 bookkeeper checks → save →        └───────────────▲──────────────────────────▲──────────────────────────┘
                  reviewer email (Approve / Reject)                         read-only│                          │ read (+ approve/reject
                                                                                     │                          │   after y/n, secret key)
                                                     2. Invoice Reporting Dashboard  │      3. Invoice Assistant Agent (this repo)
                                                        Next.js, Overview / Reports  │         terminal chat, Claude + 10 tools,
                                                        / Invoices / Errors ─────────┘         reconciliation, email drafts
```

- **One data contract, one set of rules.** The flag codes and their explanations, the $5,000 approval limit, 6 minutes saved per invoice, Monday-to-Sunday weeks in Asia/Manila time, and "rejected invoices don't count toward totals" are copied unchanged from the dashboard (`src/shared/`). The assistant's weekly report shows exactly the same numbers as the dashboard's Reports page.
- The n8n agent **writes** invoices, the dashboard **shows** them, and this agent **answers questions and takes actions** on them.

## How the agent loop works

Claude can't see the database. It can only ask the program to run a tool and then read the result.

1. **You ask a question.** The program sends it to Claude along with the list of tools: names, descriptions and allowed inputs.
2. **Claude replies with a tool request** instead of an answer, for example `search_invoices {"status":"flagged"}`.
3. **The program checks the input** with zod. If it's wrong (for example `status: "paid"`), the error goes back to Claude, which fixes it and tries again. The program never crashes on bad input.
4. **The program runs the tool** (a normal TypeScript function) and sends the result back.
5. **Steps 2–4 repeat** until Claude answers in plain text. There's a safety limit of **8 tool calls per question**.
6. **History is kept** for the whole session, so follow-ups work: "and which of those are over $5,000?"

The loop is written out by hand in [src/providers/anthropic-api.ts](src/providers/anthropic-api.ts), with comments, so you can follow it.

## Two AI provider modes (one setting: `AI_PROVIDER`)

| | `claude-code` (default) | `anthropic-api` |
|---|---|---|
| Uses | My Claude subscription, through the **Claude Agent SDK** (Claude Code logged in as me) | The **Anthropic API** with `ANTHROPIC_API_KEY` |
| Who runs the loop | Claude Code | Our own code (`@anthropic-ai/sdk`, manual tool-use loop) |
| For | **Local, personal use only** | **What a real deployment would use**, and anyone cloning this repo |
| Cost shown in `--verbose` | Tokens only (subscription) | Tokens + estimated $ per question |

Both modes share the same tools, input checks, safety rules, y/n confirmation and reconciliation code. Only the "talk to Claude" file differs.

In subscription mode, all of Claude Code's built-in tools are switched off. It can't edit files, run shell commands or browse the web, and only this project's 10 tools are allowed. Your personal Claude Code settings, plugins and hooks aren't loaded, and Claude Code receives no API key or Supabase keys. Anthropic's terms allow your own subscription login for personal use, but a product offered to other people must use API keys. So subscription mode stays on my machine, and API mode is the deployable path.

The default model is `claude-sonnet-5-5` (the tools do the math; Claude picks tools and explains). You can change it with `CLAUDE_MODEL`.

## Tools

| Tool | What it does |
|---|---|
| `search_invoices` | Filter by status, vendor, dates (processed / invoice / due / reviewed), amount, flag reason, overdue, reviewer. Lists up to 25 with the count and total of all matches |
| `get_invoice` | One invoice: line items, each flag with its plain-English explanation, the math problems, low-confidence fields, payment status, reviewer and review note |
| `vendor_summary` | Per vendor: total spent, invoice count, paid vs unpaid, problem rate |
| `weekly_report` | The dashboard's weekly report (same rules), compared with the week before |
| `list_errors` | Recent n8n workflow failures from `error_log` |
| `list_statement_files` | Which statement CSVs are available to reconcile |
| `reconcile_vendor_statement` | Vendor statement vs our invoices and payments (see below) |
| `reconcile_bank_statement` | Bank statement vs our payments (see below) |
| `draft_vendor_email` | Writes the email text from a reconciliation result. **Never sends anything** |
| `update_invoice_status` | Approve or reject a **flagged** invoice: y/n prompt, then a reason (required for rejections and amounts over $5,000) |

Each tool is one file in [src/tools/](src/tools/): a description, zod input rules and a function. To add a tool, write the file and add it to [src/tools/index.ts](src/tools/index.ts). The planned RAG search over AP policies and vendor contracts will be added this way.

## Reconciliation

**The matching is code, not AI.** Claude only explains the result and suggests next steps.

| | Matched when |
|---|---|
| Statement invoice ↔ our invoice | Same invoice number (case and spaces ignored) and amount within $0.01 |
| Statement payment ↔ our payment | Same reference; without one, amount within $0.01 and dates within 3 days |
| Bank withdrawal ↔ our payment | Same reference (then amount within $0.01 and date within 3 days); without one, amount + date |

- **Vendor statement results:**
  - matched items
  - missing in our records
  - missing from their statement
  - amount differences
  - payments they haven't applied
  - invoices we rejected that they still bill
  - **the balance difference, explained to the cent** (matches within $0.01 are counted as rounding)
- **Bank statement results:** matched, not yet cleared, unexplained withdrawals, amount differences (for example swapped digits: $287.40 recorded, $278.40 cleared), date differences.
- Every difference gets a **suggested action**. Results can be saved as a **CSV report** in `reports/`.
- **Demo data that survives re-seeding:**
  - `npm run seed:recon` builds the demo payments and the sample statements from the **current** invoices, so nothing is hard-coded.
  - Every planted difference is listed in `samples/planted-differences.json`, which tests and the eval check against.
  - Payments use `ON DELETE CASCADE`, so re-seeding the dashboard cleans them up.

**After re-seeding the dashboard, run `npm run seed:recon`.**

## Safety rules

- **Read-only by default.** `DATA_SCOPE=demo` reads only `is_demo = true` rows with the publishable key, the same as the public dashboard. Row-level security enforces it, and writes with that key are blocked (tested).
- **The secret key is used only for** `update_invoice_status` (after you type y) and `npm run seed:recon`. Changing real, non-demo invoices is off unless `ALLOW_REAL_UPDATES=true`.
- **Human in the loop.** The y/n confirmation and the reason prompt are asked by the program itself, not by Claude, in both modes. The eval answers "no" to every confirmation.
- **Files:** statements are read only from `samples/` (or `STATEMENTS_DIR`), only `.csv` files. `../`, absolute paths and links leading outside are refused (tested).
- **No leaks:** keys are never printed. Database and API error details go to `logs/app.log` with keys masked, and you see a friendly message.
- **Reliability:** Supabase calls retry twice with a short wait and time out after 15 seconds. The Anthropic SDK retries busy errors. Missing or wrong keys, Claude Code not logged in, and missing or badly formatted statement files each get a clear message.

## Run it

```bash
npm install
cp .env.example .env          # SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (+ SUPABASE_SECRET_KEY to approve/reject and seed)
npm test                      # no database, no AI, no cost
npm run tool -- search_invoices status=flagged     # one tool, no AI
npm run desktop               # the desktop app (or npm run desktop:build for the Windows installer)
npm run app                   # the web app → http://localhost:3210
npm run chat                  # the same agent in the terminal
npm run chat -- --verbose     # shows every tool call, its result, and token use per question
```

- **Subscription mode:** install Claude Code and log in (`claude`, then `/login`).
- **API mode:** set `AI_PROVIDER=anthropic-api` and `ANTHROPIC_API_KEY`.
- **Database (once):** the invoice tables come from the [dashboard project](https://lovergil-perillo-portfolio.vercel.app). Then run [supabase/payments.sql](supabase/payments.sql) in the Supabase SQL Editor, followed by `npm run seed:recon`.

Node 22.18+ runs the TypeScript directly; there's no build step. The web app is plain HTML/CSS/JS served by Node's built-in server. There are 4 runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@supabase/supabase-js` and `zod`.

## Sample conversation

From a real `--verbose` session, shortened:

```
You: Which invoices are flagged and waiting for review?
  → search_invoices {"status":"flagged"}
Assistant: 5 invoices are flagged and waiting for review, totaling $16,322.80.
  | HLP-17296 | Harbor Legal Partners     | $10,791.08 | Over approval limit          |
  | BPK-13221 | Bluepeak Marketing Agency | $2,967.59  | Possible duplicate           |
  | APX-15716 | Apex Cloud Hosting        | $1,787.85  | Due date before invoice date |
  ...
  - BPK-13221: compare with earlier Bluepeak invoices before paying; it's past due.

You: and which of those are over $5,000?
  → search_invoices {"status":"flagged","min_total":5000}
Assistant: Only one: HLP-17296, Harbor Legal Partners, $10,791.08, flagged Over approval limit.

You: Reconcile the October bank statement.
  → list_statement_files {}
  → reconcile_bank_statement {"file":"bank-statement-2026-10.csv","month":"2026-10"}
Assistant: 68 payments matched ($174,176.23). Four items need attention:
  | Amount differs         | CHK-10580               | recorded $287.40, bank took $278.40: looks like swapped digits |
  | Unexplained withdrawal | ACH DEBIT RAPID PRINT CO | $285.93, no matching payment: find out what it is |
  | Date difference        | CHK-10549               | cleared 9 days after the payment date: normal for a mailed check |
  | Not yet cleared        | ACH2026100213           | $397.49 paid today: normal |
```

Approving looks like this. The program asks, not Claude, and nothing changes unless you type y:

```
Approve HLP-17296 from Harbor Legal Partners for $10,791.08? (y/n) y
Reason (required):
```

## Tests and eval

**Tests:** `npm test` runs 38 tests in about a second. They use no database, no AI and cost nothing.
- every tool, against a fake in-memory database
- the agent loop, with a fake Claude that replays scripted responses: tool calls, bad input, follow-ups, the 8-call limit, errors rolled back
- approve/reject with the y/n and reason rules
- the web server: streamed steps, the y/n and reason handshake with the browser, a closed tab counting as "no", and the local-only checks
- file-path safety
- reconciliation: statements are generated from random invoice sets, and the test checks that **every planted difference is found and nothing else**, with the balance difference fully explained

**Eval:** `npm run eval` asks Claude 13 real questions (including follow-ups, an unknown invoice, and all three reconciliation questions). For each one it checks that Claude called the expected tool and that the answer contains the key fact. The expected facts are worked out by running the tools directly on the current data and the planted answer key. It warns before starting: in `claude-code` mode it uses your subscription, and in API mode it costs money.

Latest run: **13/13 passed** (claude-code mode, `claude-sonnet-5-5`, Oct 29, 2026, 7–14 s per question). Full table: [docs/eval-results.md](docs/eval-results.md).

| # | Question | Tool | Key fact checked |
|---|---|---|---|
| 1 | Which invoices are flagged and waiting for review? | `search_invoices` | Total of the flagged invoices |
| 2 | …and which of those are over $5,000? (follow-up) | `search_invoices` | The invoice number |
| 3 | Why was invoice HLP-17296 flagged? | `get_invoice` | The flag reason |
| 4 | How much did we spend with Summit Logistics this month? | `vendor_summary` | The amount |
| 5 | What were the top problem reasons last week? | `weekly_report` | The top reason |
| 6 | Which vendors send the most problem invoices? | `vendor_summary` | The top vendor |
| 7 | What's overdue? | `search_invoices` | Overdue total |
| 8 | Have there been any workflow errors recently? | `list_errors` | The failed step |
| 9 | Why was invoice INV-99999 flagged? | `get_invoice` | Says it wasn't found (no inventing) |
| 10 | Show me what was approved or rejected this week and why. | `search_invoices` | The reviewed invoice |
| 11 | Reconcile Summit Logistics' October statement. | `reconcile_vendor_statement` | All 4 planted differences |
| 12 | Reconcile the October bank statement. | `reconcile_bank_statement` | All 4 planted differences |
| 13 | Draft an email to Summit asking for the missing invoices. | `draft_vendor_email` | The missing invoice number |

## Data contract

Same database as the dashboard. The dashboard's README defines `invoices`, `run_log`, `error_log`, `vendors` and `purchase_orders`. This project adds:

### `invoices`: two new columns (added by `supabase/payments.sql`)

| Column | Type | Rule |
|---|---|---|
| `review_note` | text | Why a person approved or rejected the invoice. Required by the assistant for rejections and for invoices over the approval limit, optional otherwise. Max 500 characters. `null` when none. |
| `reviewed_by` | text | Who made the decision, e.g. `"Invoice Assistant (CLI)"`. `null` for decisions made before this column existed (the n8n reviewer email can fill it later). |

`status` and `reviewed_at` are set exactly as the dashboard contract says (`approved` / `rejected`, ISO time).

### `payments`: one row per payment made against an invoice

| Column | Type | Required | Rule |
|---|---|---|---|
| `payment_id` | text, primary key | yes | Unique id, e.g. `"PAY-202610-0042"` |
| `invoice_id` | uuid | yes | `invoices.id` the payment is for. Foreign key with `ON DELETE CASCADE`: deleting an invoice deletes its payments. |
| `vendor` | text | no | Same name as `invoices.vendor` |
| `amount` | numeric(12,2) | yes | Greater than 0, USD |
| `paid_date` | date | yes | `"YYYY-MM-DD"`, the day the payment was sent |
| `method` | text | no | `ACH`, `CHECK`, `WIRE` or `CARD` |
| `reference` | text | no | As the bank shows it: ACH trace, check number (`CHK-10442`) or wire reference. Used to match bank lines. |
| `is_demo` | boolean | yes | `true` only for seeded demo rows |
| `created_at` | timestamptz | yes | Filled by the database |

Rules:
- An invoice is **paid** when its payments add up to its `total` (within $0.01), **partly paid** when they add up to less, and **unpaid** when it has no payments. Rejected invoices are never payable.
- **Overdue** means status `clean` or `approved`, `due_date` before today (Asia/Manila), and not fully paid.
- Security: RLS is on. The publishable key can only `SELECT` rows with `is_demo = true`, and insert/update/delete are revoked for `anon` and `authenticated`. Writes need the secret key.

### Statement files (`samples/`, or the folder in `STATEMENTS_DIR`)

- **Vendor statement:** `date,type,reference,description,amount`. `type` is `opening_balance`, `invoice`, `payment`, `credit` or `closing_balance`. Amounts are positive (payments and credits reduce the balance). Dates are `YYYY-MM-DD`.
- **Bank statement:** `date,description,reference,amount`. Withdrawals are negative.

## Project layout

```
src/
  chat.ts              terminal chat, --verbose, the y/n and reason prompts
  app.ts · server.ts   web app: local server, streamed turns, y/n and reason over HTTP
desktop/               main.mjs (Electron window around the same server) · start.mjs · icon
  agent.ts             system prompt, 8-call safety limit, what both modes share
  providers/           anthropic-api.ts (hand-written loop) · claude-code.ts (Agent SDK) · index.ts (picks one)
  tools/               one file per tool + index.ts (the list and the input check)
  recon/               match.ts (the rules) · run.ts · files.ts (safe file reading, CSV) · seed-data.ts
  data.ts              every Supabase read/write
  safety.ts            friendly errors, logs/app.log, key masking
  shared/              copied from the dashboard: config, format, week, report math
web/                   index.html · app.css · app.js (the browser UI, no framework)
scripts/               tool.ts (run one tool) · seed-recon.ts · eval.ts
supabase/payments.sql  payments table + review columns + RLS
samples/               generated statements + planted-differences.json
test/                  tools, agent loop, reconciliation (fake database, fake Claude)
```

## Later

RAG search over AP policies and vendor contracts (Supabase pgvector + Ollama embeddings), as one more tool file in `src/tools/`.
