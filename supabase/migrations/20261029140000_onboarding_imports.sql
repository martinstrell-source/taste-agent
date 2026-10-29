-- Onboarding and imports.
-- 1. import_jobs: work for the Mac mini's import worker (import_worker.py, every few minutes):
--    'takeout'  a Google Maps Takeout file the user uploaded: ingest, read notes, match on Google, profile, picks
--    'refresh'  rebuild the user's profile and picks (after onboarding)
--    The app adds 'takeout' jobs and reads its own jobs' status; the server adds 'refresh' jobs.
-- 2. "imports" storage bucket: Takeout files, one folder per user id, private.

create table if not exists public.import_jobs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.app_users(user_id) on delete cascade,
  kind        text not null check (kind in ('takeout', 'refresh')),
  storage_path text,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  message     text,
  counts      jsonb,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists import_jobs_status_idx on public.import_jobs (status, created_at);
create index if not exists import_jobs_user_idx on public.import_jobs (user_id, created_at);
alter table public.import_jobs enable row level security;
grant select, insert on public.import_jobs to authenticated;
grant all on public.import_jobs to service_role;
drop policy if exists own_read on public.import_jobs;
create policy own_read on public.import_jobs for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists own_takeout on public.import_jobs;
create policy own_takeout on public.import_jobs for insert to authenticated
  with check (user_id = (select auth.uid()) and kind = 'takeout' and status = 'queued'
              and storage_path like (select auth.uid())::text || '/%');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 52428800,
        array['application/zip', 'application/x-zip-compressed', 'text/csv', 'application/octet-stream'])
on conflict (id) do nothing;

drop policy if exists "imports: own folder, add" on storage.objects;
create policy "imports: own folder, add" on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "imports: own folder, read" on storage.objects;
create policy "imports: own folder, read" on storage.objects for select to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
