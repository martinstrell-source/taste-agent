-- Taste Agent: schema update 7 (run once in the SQL Editor, after schema_v6.sql). Safe to run more than once.
--
-- Discover here:
-- 1. pick_scores.source says who scored a pick: 'match' (the weekly run) or 'discover' (Discover here),
--    so the weekly run replaces only its own scores.
-- 2. discover_runs counts each user's web searches, for the daily limit.

alter table public.pick_scores add column if not exists source text not null default 'match';

create table if not exists public.discover_runs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.app_users(user_id) on delete cascade,
  area_key   text,
  kind       text,
  created_at timestamptz not null default now()
);
create index if not exists discover_runs_user_idx on public.discover_runs (user_id, created_at);
alter table public.discover_runs enable row level security;
grant select on public.discover_runs to authenticated;
grant all on public.discover_runs to service_role;
drop policy if exists own_rows on public.discover_runs;
create policy own_rows on public.discover_runs for select to authenticated using (user_id = (select auth.uid()));
