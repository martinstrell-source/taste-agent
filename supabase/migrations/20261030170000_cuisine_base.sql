-- How common each cuisine is among Bay Area food places, from the shared pool: places in the news, plus
-- Discover's general "best restaurants" searches. Discover's cuisine searches are left out: they look for the
-- user's own top cuisines and would make those look more common than they are.
-- Discover (and the weekly matcher) rank a user's cuisines by how much more often they save them than this,
-- so Mexican, common in the Bay Area, counts for less than Burmese.
create or replace view public.cuisine_base as
with pool as (
  select distinct on (google_place_id) google_place_id, categories
  from candidates
  where is_food and in_bay_area and google_place_id is not null
    and (item_id not like 'here:%' or item_id like 'here:%:g:best')
  order by google_place_id, created_at desc
), total as (
  select count(*)::real as n from pool
)
select regexp_replace(t, '_restaurant$', '') as cuisine,
       count(*)::int as places,
       count(*)::real / nullif((select n from total), 0) as share,
       (select n from total)::int as pool_size
from pool, unnest(pool.categories) t
where t like '%\_restaurant'
group by 1;

grant select on public.cuisine_base to authenticated, service_role;
