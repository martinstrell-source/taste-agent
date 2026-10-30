-- Nearby: which places just opened. "New pick" only ever meant "new to you"; old places like Shan Dong
-- carried it too. just_opened = the news reported it as an opening in the last 6 months, or it has very few
-- Google reviews so far (a guess). opened_note says which. The return columns change, so drop first.
drop function if exists public.nearby(double precision, double precision, double precision, int, uuid);
create or replace function public.nearby(lat double precision, lng double precision,
                                         radius_m double precision default 2000,
                                         max_rows int default 50,
                                         for_user uuid default null)
returns table (kind text, ref text, name text, address text, place_lat double precision,
               place_lng double precision, distance_m double precision, categories text[],
               list_name text, note text, google_place_id text, rating real, review_count int,
               price_level text, opening_hours jsonb, added_at timestamptz, added_via text,
               score real, why text, just_opened boolean, opened_note text)
language sql stable
set search_path = public, extensions
as $$
  with me as (
    select coalesce(case when (select auth.role()) = 'service_role' then for_user end,
                    (select auth.uid())) as uid
  ), here as (
    select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g
  ), fresh as (
    -- reported as an opening by the news in the last 6 months (newest report per place)
    select distinct on (c.google_place_id) c.google_place_id,
           'Opening reported by ' || c.source || coalesce(' in ' || to_char(c.published, 'FMMonth'), '') as note
    from candidates c
    where c.mention_type = 'opening' and c.google_place_id is not null and c.item_id not like 'here:%'
      and coalesce(c.in_bay_area, true)
      and coalesce(c.published, c.created_at::date) > current_date - 180
    order by c.google_place_id, coalesce(c.published, c.created_at::date) desc
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
           b.created_at, b.added_via, null::real, null::text,
           fr.note is not null, fr.note
    from best b cross join here
    left join notes n on n.key = b.key
    left join place_ratings r on r.google_place_id = b.google_place_id
    left join fresh fr on fr.google_place_id = b.google_place_id
  ), picks as (
    select distinct on (c.google_place_id)
           'pick'::text, c.google_place_id, c.google_name, c.address,
           st_y(c.location::geometry), st_x(c.location::geometry),
           st_distance(c.location, here.g), c.categories, null::text, c.what_it_says,
           c.google_place_id, r.rating, r.user_rating_count, r.price_level, r.opening_hours,
           c.created_at, 'pick'::text, ps.score, ps.reason,
           -- just opened: an opening in the news, or very few Google reviews so far (a guess: could be little known)
           fr.note is not null or c.what_it_says like 'New: %' or coalesce(r.user_rating_count, 1000) < 30,
           coalesce(fr.note, case when c.what_it_says like 'New: %' or coalesce(r.user_rating_count, 1000) < 30
                                  then 'Only a few reviews on Google so far' end)
    from candidates c cross join here cross join me
    left join place_ratings r on r.google_place_id = c.google_place_id
    left join fresh fr on fr.google_place_id = c.google_place_id
    left join pick_scores ps on ps.user_id = me.uid and ps.google_place_id = c.google_place_id
    where c.is_food and c.location is not null and c.google_place_id is not null
      and coalesce(c.business_status, 'OPERATIONAL') = 'OPERATIONAL'
      and c.mention_type not in ('closing', 'passing') and c.match_confidence <> 'weak'
      and coalesce(c.tone, 'neutral') <> 'negative'
      and st_dwithin(c.location, here.g, radius_m)
      and (c.item_id like 'here:%' or c.in_bay_area is not false)
      and not exists (select 1 from places p where p.user_id = me.uid and p.google_place_id = c.google_place_id)
      and not exists (select 1 from feedback f where f.user_id = me.uid and f.google_place_id = c.google_place_id)
    order by c.google_place_id, c.created_at desc
  )
  select * from (select * from saved union all select * from picks) x
  order by distance_m
  limit max_rows;
$$;
grant execute on function public.nearby to authenticated, service_role;
