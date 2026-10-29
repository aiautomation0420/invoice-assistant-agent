-- Invoice Assistant Agent: payments table + review note columns.
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to run again.
-- Touches only: new table "payments", and two new empty columns on "invoices".
-- Does NOT change other tables, existing policies, the RAG "documents" table or the match_documents function.

-- ── 1. Review notes on invoices (written by the assistant's approve/reject, after you type y) ──────
alter table public.invoices add column if not exists review_note text;  -- why it was approved/rejected
alter table public.invoices add column if not exists reviewed_by text;  -- e.g. 'Invoice Assistant (CLI)'

-- ── 2. Payments: one row per payment made against an invoice ────────────────────────────────────
create table if not exists public.payments (
  payment_id text primary key,                                    -- e.g. 'PAY-202610-0042'
  invoice_id uuid not null references public.invoices (id) on delete cascade,  -- re-seeding invoices removes their payments
  vendor     text,                                                -- vendor name, same as invoices.vendor
  amount     numeric(12, 2) not null check (amount > 0),
  paid_date  date not null,                                       -- the day we sent the payment
  method     text check (method in ('ACH', 'CHECK', 'WIRE', 'CARD')),
  reference  text,                                                -- ACH trace / check number / wire ref, as the bank shows it
  is_demo    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists payments_invoice_id_idx on public.payments (invoice_id);
create index if not exists payments_paid_date_idx on public.payments (paid_date);

-- ── 3. Security: the publishable key may READ demo payments only, and never write ───────────────
alter table public.payments enable row level security;

drop policy if exists "assistant reads demo payments" on public.payments;
create policy "assistant reads demo payments" on public.payments for select to anon using (is_demo);

grant select on public.payments to anon;
revoke insert, update, delete, truncate on public.payments from anon, authenticated;

-- ── Check the result ────────────────────────────────────────────────────────────────────────────
select tablename, rowsecurity as rls_on from pg_tables where schemaname = 'public' and tablename in ('invoices', 'payments');
select column_name from information_schema.columns where table_name = 'invoices' and column_name in ('review_note', 'reviewed_by');
