-- schema_v8: Discover away from home.
-- area_profiles: what each city is known for (local specialties and strengths), asked once and shared by all users.
-- home_point(uid): the center of where most of a user's saved places are, to tell "home" from "away".
-- Safe to run more than once.

create table if not exists public.area_profiles (
  city_key   text primary key,          -- about 50 km cell, e.g. '40.0,116.5'
  area_name  text,
  profile    jsonb not null,            -- {"local": [{name, query, tags}], "strengths": [...]}
  created_at timestamptz not null default now()
);
alter table public.area_profiles enable row level security;  -- no policies: only the server functions use it

create or replace function public.home_point(uid uuid)
returns table (lat double precision, lng double precision)
language sql stable security definer set search_path = public, extensions
as $$
  with p as (
    select st_y(location::geometry) as y, st_x(location::geometry) as x
    from public.places
    where user_id = uid and location is not null and removed_at is null
  ), cell as (
    select round(y) as ry, round(x) as rx from p group by 1, 2 order by count(*) desc limit 1
  )
  select avg(p.y), avg(p.x) from p join cell on round(p.y) = cell.ry and round(p.x) = cell.rx;
$$;
revoke execute on function public.home_point(uuid) from public, anon, authenticated;
grant execute on function public.home_point(uuid) to service_role;
