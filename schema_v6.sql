-- Taste Agent: schema update 6 (run once in the SQL Editor, after schema_v5.sql). Safe to run more than once.
--
-- 1. Log a visit: private photo storage and a few more fields on visits.
-- 2. Best match sort: match.py saves each pick's taste score and a short reason per user (pick_scores),
--    and nearby() returns them.
-- Photos live in the "visit-photos" bucket, in a folder named after the user's id; only that user
-- can upload, see or delete them. The bill photo is kept only if the user chooses to.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visit-photos', 'visit-photos', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "visit photos: own folder, read" on storage.objects;
create policy "visit photos: own folder, read" on storage.objects for select to authenticated
  using (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "visit photos: own folder, add" on storage.objects;
create policy "visit photos: own folder, add" on storage.objects for insert to authenticated
  with check (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "visit photos: own folder, delete" on storage.objects;
create policy "visit photos: own folder, delete" on storage.objects for delete to authenticated
  using (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter table public.visits add column if not exists bill_path text;      -- the bill photo, only if kept
alter table public.visits add column if not exists bill_total numeric;
alter table public.visits add column if not exists place_name text;     -- for visits to picks (no saved row)
create index if not exists visits_gid_idx on public.visits (user_id, google_place_id);

-- ---------- Best match: taste scores per user, written by match.py ----------
create table if not exists public.pick_scores (
  user_id         uuid not null references public.app_users(user_id) on delete cascade,
  google_place_id text not null,
  score           real,
  reason          text,
  updated_at      timestamptz not null default now(),
  primary key (user_id, google_place_id)
);
alter table public.pick_scores enable row level security;
grant select on public.pick_scores to authenticated;
grant all on public.pick_scores to service_role;
drop policy if exists own_rows on public.pick_scores;
create policy own_rows on public.pick_scores for select to authenticated using (user_id = (select auth.uid()));

-- nearby(): as in schema_v5, plus each pick's score and reason (the return columns change, so drop first)
drop function if exists public.nearby(double precision, double precision, double precision, int, uuid);
create or replace function public.nearby(lat double precision, lng double precision,
                                         radius_m double precision default 2000,
                                         max_rows int default 50,
                                         for_user uuid default null)
returns table (kind text, ref text, name text, address text, place_lat double precision,
               place_lng double precision, distance_m double precision, categories text[],
               list_name text, note text, google_place_id text, rating real, review_count int,
               price_level text, opening_hours jsonb, added_at timestamptz, added_via text,
               score real, why text)
language sql stable
set search_path = public, extensions
as $$
  with me as (
    select coalesce(case when (select auth.role()) = 'service_role' then for_user end,
                    (select auth.uid())) as uid
  ), here as (
    select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g
  ), saved_rows as (
    -- every saved copy near here; copies of the same Google place share a key
    select coalesce(p.google_place_id, 'row:' || p.id) as key,
           case p.list_name when 'favorites' then 0 when 'want_to_go' then 1 else 2 end as list_rank,
           p.*
    from places p cross join here cross join me
    where p.user_id = me.uid and p.is_food and p.location is not null
      and p.removed_at is null and p.hidden_at is null
      and coalesce(p.match_confidence, '') <> 'weak'
      and st_dwithin(p.location, here.g, radius_m)
  ), best as (
    select distinct on (key) * from saved_rows order by key, list_rank, id
  ), notes as (
    select key, string_agg(distinct trim(note), E'\n\n') as notes
    from saved_rows where trim(coalesce(note, '')) <> '' group by key
  ), saved as (
    select 'saved'::text as kind, b.id::text as ref, coalesce(b.google_name, b.title) as name, b.address,
           st_y(b.location::geometry) as place_lat, st_x(b.location::geometry) as place_lng,
           st_distance(b.location, here.g) as distance_m, b.categories, b.list_name, n.notes as note,
           b.google_place_id, r.rating, r.user_rating_count, r.price_level, r.opening_hours,
           b.created_at, b.added_via, null::real, null::text
    from best b cross join here
    left join notes n on n.key = b.key
    left join place_ratings r on r.google_place_id = b.google_place_id
  ), picks as (
    select distinct on (c.google_place_id)
           'pick'::text, c.google_place_id, c.google_name, c.address,
           st_y(c.location::geometry), st_x(c.location::geometry),
           st_distance(c.location, here.g), c.categories, null::text, c.what_it_says,
           c.google_place_id, r.rating, r.user_rating_count, r.price_level, r.opening_hours,
           c.created_at, 'pick'::text, ps.score, ps.reason
    from candidates c cross join here cross join me
    left join place_ratings r on r.google_place_id = c.google_place_id
    left join pick_scores ps on ps.user_id = me.uid and ps.google_place_id = c.google_place_id
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
