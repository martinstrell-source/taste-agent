-- Taste Agent: schema update 9 (run once in the SQL Editor, after schema_v8.sql). Safe to run more than once.
--
-- Discovery trace: every Discover run is saved with what it did (searches, pages Claude read, its answer,
-- what Google confirmed, every place dropped and why), how long it took, and any error.
-- A run is written first as '<mode>-started' and updated when it finishes, so a run cut off by a time
-- limit still shows up. Read traces with the queries in discover_trace.sql.

alter table public.discover_runs add column if not exists area_name text;
alter table public.discover_runs add column if not exists ms integer;
alter table public.discover_runs add column if not exists error text;
alter table public.discover_runs add column if not exists trace jsonb;
