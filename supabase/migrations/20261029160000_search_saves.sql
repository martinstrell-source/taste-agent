-- Search bar: the user's own saved places whose name matches, nearest first (row level security applies).
-- A place saved twice shows once, under its strongest list (as in nearby()).
create or replace function public.search_saves(q text, lat double precision default null, lng double precision default null)
returns table (ref text, name text, address text, place_lat double precision, place_lng double precision,
               list_name text, google_place_id text, categories text[], distance_m double precision)
language sql stable security invoker set search_path = public, extensions
as $$
  with hits as (
    select distinct on (coalesce(p.google_place_id, p.id::text))
           p.id::text as ref, coalesce(p.google_name, p.title) as name, p.address,
           st_y(p.location::geometry) as place_lat, st_x(p.location::geometry) as place_lng,
           p.list_name, p.google_place_id, p.categories,
           case when lat is null or lng is null then null
                else st_distance(p.location, st_setsrid(st_makepoint(lng, lat), 4326)::geography) end as distance_m
    from public.places p
    where p.user_id = (select auth.uid()) and p.location is not null and p.removed_at is null and p.hidden_at is null
      and length(trim(q)) >= 2
      and (p.google_name ilike '%' || trim(q) || '%' or p.title ilike '%' || trim(q) || '%')
    order by coalesce(p.google_place_id, p.id::text),
             case p.list_name when 'favorites' then 0 when 'want_to_go' then 1 else 2 end, p.id
  )
  select * from hits order by distance_m nulls last, name limit 6;
$$;
grant execute on function public.search_saves(text, double precision, double precision) to authenticated;
