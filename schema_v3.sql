-- Taste Agent: schema update 3 (run once in the SQL Editor, after schema.sql and schema_v2.sql).
-- Places taken off a user's Google Maps lists are marked removed instead of deleted (ingest.py).
-- Removed places leave the taste profile and Nearby, but are still never suggested as picks.
-- Safe to run more than once.

alter table public.places add column if not exists removed_at timestamptz;

-- nearby(): same as before, except removed places no longer show as saved
create or replace function public.nearby(lat double precision, lng double precision,
                                         radius_m double precision default 2000,
                                         max_rows int default 50,
                                         for_user uuid default null)
returns table (kind text, ref text, name text, address text, place_lat double precision,
               place_lng double precision, distance_m double precision, categories text[],
               list_name text, note text)
language sql stable
set search_path = public, extensions
as $$
  with me as (
    select coalesce(case when (select auth.role()) = 'service_role' then for_user end,
                    (select auth.uid())) as uid
  ), here as (
    select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g
  ), saved as (
    select 'saved'::text as kind, p.id::text as ref, coalesce(p.google_name, p.title) as name, p.address,
           st_y(p.location::geometry) as place_lat, st_x(p.location::geometry) as place_lng,
           st_distance(p.location, here.g) as distance_m, p.categories, p.list_name, p.note
    from places p, here, me
    where p.user_id = me.uid and p.is_food and p.location is not null and p.removed_at is null
      and coalesce(p.match_confidence, '') <> 'weak'
      and st_dwithin(p.location, here.g, radius_m)
  ), picks as (
    select distinct on (c.google_place_id)
           'pick'::text as kind, c.google_place_id as ref, c.google_name as name, c.address,
           st_y(c.location::geometry), st_x(c.location::geometry),
           st_distance(c.location, here.g), c.categories, null::text, c.what_it_says
    from candidates c, here, me
    where c.is_food and c.location is not null and c.google_place_id is not null
      and coalesce(c.business_status, 'OPERATIONAL') = 'OPERATIONAL'
      and c.mention_type not in ('closing', 'passing') and c.match_confidence <> 'weak'
      and coalesce(c.tone, 'neutral') <> 'negative'
      and st_dwithin(c.location, here.g, radius_m)
      and not exists (select 1 from places p where p.user_id = me.uid and p.google_place_id = c.google_place_id)
      and not exists (select 1 from feedback f where f.user_id = me.uid and f.google_place_id = c.google_place_id)
    order by c.google_place_id, c.created_at desc
  )
  select * from (select * from saved union all select * from picks) x
  order by distance_m
  limit max_rows;
$$;
grant execute on function public.nearby to authenticated, service_role;
