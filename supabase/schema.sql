-- Installed on Supplier Evaluation V2 project urleehfogorsoliloqkn, Singapore.
-- Never run against the existing Asy fam project.
-- Uses the service role only; no public table access or user-created policies.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.evaluation_requests (
  id uuid primary key default gen_random_uuid(),
  po_number text not null check (char_length(po_number) between 1 and 80),
  supplier_name text not null check (char_length(supplier_name) between 1 and 160),
  evaluator_name text not null check (char_length(evaluator_name) between 1 and 120),
  evaluator_email text not null check (char_length(evaluator_email) between 3 and 254),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'submitted')),
  email_sent_at timestamptz,
  resend_email_id text,
  rating integer check (rating between 1 and 5),
  comments text check (char_length(comments) <= 2000),
  submitted_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists evaluation_requests_created_at_idx on public.evaluation_requests (created_at desc);
create index if not exists evaluation_requests_status_idx on public.evaluation_requests (status);

alter table public.admin_users enable row level security;
alter table public.evaluation_requests enable row level security;

-- The browser never queries tables directly. Admin auth & data access use
-- server-side Cloudflare Worker with a service role key and explicit checks.
revoke all on table public.admin_users from public, anon, authenticated;
revoke all on table public.evaluation_requests from public, anon, authenticated;
grant select, insert, update on table public.admin_users to service_role;
grant select, insert, update on table public.evaluation_requests to service_role;

-- After creating + confirming your admin account under Supabase > Authentication > Users,
-- replace YOU@EXAMPLE.COM with the admin account email and run manually:
-- insert into public.admin_users (user_id)
-- select id from auth.users where lower(email) = lower('YOU@EXAMPLE.COM')
-- on conflict (user_id) do nothing;

-- Keep newly created public schema objects private by default.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
