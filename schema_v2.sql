-- Taste Agent: schema update for the pipeline scripts (run once in the SQL Editor, after schema.sql).
-- Adds the few columns the scripts use that schema.sql left out. Safe to run more than once.

alter table public.places           add column if not exists raw_tags text;        -- Takeout "Tags" column
alter table public.places           add column if not exists enrich_version int;   -- enrich.py skips places already done
alter table public.note_extractions add column if not exists input_tokens int;
alter table public.note_extractions add column if not exists output_tokens int;

-- places copied over before this column existed were all enriched with v2
update public.places set enrich_version = 2
 where enrich_version is null and match_confidence is not null;

-- pt(lat, lng): a map point for the scripts; null when either coordinate is missing
create or replace function public.pt(lat double precision, lng double precision)
returns extensions.geography language sql immutable
set search_path = public, extensions
as $$ select case when lat is null or lng is null then null
                  else st_setsrid(st_makepoint(lng, lat), 4326)::geography end $$;

-- the profile's lists are ordered (top cuisines first); jsonb re-sorts keys, json keeps them as written
alter table public.user_profiles alter column profile type json using profile::json;
