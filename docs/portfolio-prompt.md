Add my third project, **Invoice Assistant Agent**, to this portfolio. Follow the way the site already shows Project 1 (n8n AI Invoice Processing & Audit Agent) and Project 2 (Invoice Reporting Dashboard): same card or page layout, same components, same tone. Don't add new sections or features I haven't asked for.

## Screenshots

Copy these into this project's public images folder (wherever the other project images live) and use them on the card and project page:

- `D:\AI's\ClaudeCode\CodeBase-Agent\invoice-assistant-agent\docs\screenshots\web-app-light.png` (main image)
- `D:\AI's\ClaudeCode\CodeBase-Agent\invoice-assistant-agent\docs\screenshots\web-app-dark.png` (dark mode, if the site switches images by theme or has a gallery)

Both are 1440×900 screenshots of the web app's start screen. Alt text: "Invoice Assistant web app: a chat for accounts payable with suggested questions about flagged invoices, vendor spend and statement reconciliation."

## Project details

**Title:** Invoice Assistant Agent
**One-liner:** An AI agent for accounts payable, as a web app and a Windows desktop app. Ask about invoices in plain English, approve or reject flagged ones, and reconcile vendor and bank statements in seconds.
**Runs as:** a **web app** (opens in the browser at localhost) **and a Windows desktop app** (installer with Start-menu and Desktop shortcuts). Both use the same agent, tools and safety rules. There's also a terminal chat for developers.
Make it clear on the card and the project page that this is both a web app and a desktop app, for example two badges: "Web app" and "Desktop app (Windows)".
**Repo:** https://github.com/aiautomation0420/invoice-assistant-agent
**Stack:** TypeScript, Node.js, Claude (Anthropic API + Claude Agent SDK), Supabase (Postgres), zod, Electron.

**What it does**
- Answers everyday AP questions: which invoices are flagged and why (it shows the math that doesn't add up), what's overdue, how much we owe a vendor, and the weekly report.
- Approves or rejects flagged invoices, always after a y/n confirmation and a reason. The program asks these questions, not the AI.
- Reconciles a vendor statement or a bank statement against our invoices and payments. It finds missing invoices, amount differences, unapplied payments and uncleared payments, explains the balance difference to the cent, and suggests the next step for each item.
- Drafts the email to the vendor from the reconciliation results. It never sends anything.
- Saves reconciliation results as CSV reports.

**What it saves**
- Month-end statement reconciliation usually means comparing two spreadsheets side by side for about an hour. The agent does it in seconds, and every difference comes with a suggested action.
- Uses the same "6 minutes saved per invoice" measure as the dashboard. The weekly report matches the dashboard's Reports page number for number.
- No retyping: email drafts are built straight from the reconciliation results.

**How it works (for the technical section)**
- Claude can't see the database. It asks the program to run one of 10 tools, reads the result and explains it. Every number comes from a tool, never from the AI.
- The matching rules are code, not AI: same invoice number and amount within $0.01; payments matched by reference, or by amount and a 3-day date window.
- A hand-written tool-use loop, with a limit of 8 tool calls per question. Bad tool inputs are checked with zod and sent back to Claude to fix.
- Two AI modes, one setting: Claude subscription (Agent SDK, local personal use) or Anthropic API (the deployable path).
- Safety: read-only by default (demo rows, row-level security), human-in-the-loop approvals, statement files restricted to one folder, keys never logged, local web app only (127.0.0.1, Host/Origin checks, strict CSP).
- Tested: 38 automated tests (no database, no AI) and a 13-question eval where Claude is checked for calling the right tool and giving the right fact. All 13 pass.

**How it connects to the other two projects**
Project 1 (n8n) **writes** invoices to Supabase, Project 2 (dashboard) **shows** them, and Project 3 (this agent) **answers questions and takes actions** on them. All three share one data contract and the same rules ($5,000 approval limit, Monday-to-Sunday weeks in Asia/Manila time).

## When you're done
Run the site locally, check the new card and page in light and dark mode and at phone width, and tell me which files you changed.
