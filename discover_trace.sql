-- Reading Discover traces. Paste one query at a time into the Supabase SQL Editor (save each as a snippet).

-- 1. The last 10 runs: where, which step, how long, what it found, any error
select id, created_at at time zone 'America/Los_Angeles' as at, area_name, kind,
       round(ms / 1000.0, 1) as seconds, trace->'result' as result, error
from public.discover_runs
order by id desc
limit 10;

-- 2. The last quick (Google) run, search by search: what was kept, what was dropped and why
select s->>'query' as search, s->>'why' as why, s->>'bar' as bar, s->'results' as results,
       s->'kept' as kept, s->'dropped' as dropped
from public.discover_runs r, jsonb_array_elements(r.trace->'searches') s
where r.id = (select max(id) from public.discover_runs where kind = 'google');

-- 3. The last web run: what Claude searched for, how many pages it read, and what happened to each place it named
select r.trace->'claude'->'queries' as claude_searched,
       jsonb_array_length(coalesce(r.trace->'claude'->'pages', '[]'::jsonb)) as pages_read,
       f->>'name' as place, f->>'source' as source, f->>'result' as result
from public.discover_runs r, jsonb_array_elements(r.trace->'found') f
where r.id = (select max(id) from public.discover_runs where kind = 'web');

-- 4. Away from home: how far from home, and what the city is known for
select id, area_name, trace->'km_from_home' as km_from_home, trace->'city_profile' as city_profile
from public.discover_runs
where (trace->>'away')::boolean
order by id desc
limit 5;

-- 5. Claude's full answer for the last web run (long)
select trace->'claude'->>'answer' as answer
from public.discover_runs where kind = 'web' order by id desc limit 1;
