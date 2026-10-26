-- Taste Agent: Supabase schema (run once in the SQL Editor)
-- Every user-owned table has row level security: a signed-in user sees and edits only their own rows.
-- Shared tables (candidates, place_ratings) are read-only for signed-in users.
-- Pipeline tables (feed_items) are private: only the secret key (scripts) can reach them.

create extension if not exists postgis with schema extensions;

-- ---------- users ----------
create table if not exists public.app_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  handle       text unique,                 -- short name used by the scripts, e.g. 'martin'
  display_name text,
  email        text,
  home         extensions.geography(point, 4326),
  home_label   text,
  created_at   timestamptz not null default now()
);

create table if not exists public.user_shorthand (
  user_id     uuid not null references public.app_users(user_id) on delete cascade,
  term        text not null,
  type        text,
  name        text,
  description text,
  primary key (user_id, term)
);

-- what a user said directly at signup: cuisine | dish | format | source_<type> | 	dislike_*
create table if not exists public.user_prefs (
  user_id    uuid not null references public.app_users(user_id) on delete cascade,
  kind       text not null,
  value      text not null,
  raw        text,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, value)
);

-- ---------- a user's places ----------
create table if not exists public.places (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references public.app_users(user_id) on delete cascade,
  place_key         text not null,          -- Takeout feature id, or 'onboard:<google id>', 'capture:<google id>'
  list_name         text,                   -- want_to_go | favorites | <custom list> | captured
  added_via         text,                   -- takeout | onboard | capture
  title             text,
  note              text,
  url               text,
  source_type       text,                   -- for captures: person | publication | community | walk_by | ...
  source_name       text,
  source_url        text,
  google_place_id   text,
  google_name       text,
  address           text,
  location          extensions.geography(point, 4326),
  approx_location   extensions.geography(point, 4326),
  categories        text[],
  is_food           boolean,
  match_confidence  text,
  name_similarity   real,
  match_distance_m  real,
  created_at        timestamptz not null default now(),
  unique (user_id, place_key)
);
create index if not exists places_user_idx on public.places (user_id);
create index if not exists places_location_idx on public.places using gist (location);
create index if not exists places_gid_idx on public.places (google_place_id);

-- what Claude read in each note
create table if not exists public.note_extractions (
  user_id       uuid not null references public.app_users(user_id) on delete cascade,
  place_key     text not null,
  model         text,
  dishes        jsonb,
  sources       jsonb,
  source_type   text,
  source_name   text,
  intent        text,
  kind          text,
  cuisine       text,
  sentiment     text,
  constraints   jsonb,
  reason        text,
  extracted_at  timestamptz,
  primary key (user_id, place_key)
);

-- "I went": one row per visit
create table if not exists public.visits (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.app_users(user_id) on delete cascade,
  place_id      bigint references public.places(id) on delete set null,
  google_place_id text,
  visited_on    date not null default current_date,
  reaction      text check (reaction in ('love', 'fine', 'no')),
  thoughts      text,
  items_ordered jsonb,                      -- read from the bill: [{"item": "...", "price": 12.5}]
  photo_paths   text[],                     -- in Supabase Storage, private to the user
  created_at    timestamptz not null default now()
);
create index if not exists visits_user_idx on public.visits (user_id);

-- raw input behind each "Add a place" (link, pasted text, photo, friend's tip)
create table if not exists public.captures (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.app_users(user_id) on delete cascade,
  input_type   text check (input_type in ('link', 'text', 'photo', 'friend')),
  raw_input    text,
  photo_path   text,
  source_type  text,
  source_name  text,
  source_url   text,
  place_id     bigint references public.places(id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.feedback (
  user_id         uuid not null references public.app_users(user_id) on delete cascade,
  google_place_id text not null,
  name            text,
  reaction        text not null check (reaction in ('love', 'meh', 'no', 'want')),
  note            text,
  created_at      timestamptz not null default now(),
  primary key (user_id, google_place_id)
);

-- the taste profile the pipeline builds for each user
create table if not exists public.user_profiles (
  user_id    uuid primary key references public.app_users(user_id) on delete cascade,
  profile    jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.digest_items (
  user_id         uuid not null references public.app_users(user_id) on delete cascade,
  digest_date     date not null,
  google_place_id text not null,
  position        int,
  score           real,
  name            text,
  why             text,
  primary key (user_id, digest_date, google_place_id)
);

-- ---------- shared: new places from food coverage ----------
create table if not exists public.feed_items (      -- private (no grants to app roles)
  item_id    text primary key,
  source     text,
  title      text,
  link       text,
  published  date,
  fetched_at timestamptz,
  n_places   int,
  status     text,
  text_len   int,
  text       text
);

create table if not exists public.candidates (
  id                bigint generated always as identity primary key,
  item_id           text references public.feed_items(item_id) on delete cascade,
  source            text,
  item_title        text,
  item_link         text,
  published         date,
  name              text,
  location_hint     text,
  mention_type      text,
  tone              text,
  cuisine           text,
  dishes            jsonb,
  what_it_says      text,
  google_place_id   text,
  google_name       text,
  address           text,
  location          extensions.geography(point, 4326),
  categories        text[],
  primary_type      text,
  business_status   text,
  maps_uri          text,
  name_similarity   real,
  match_confidence  text,
  is_food           boolean,
  in_bay_area       boolean,
  created_at        timestamptz not null default now(),
  unique (item_id, name)
);
create index if not exists candidates_location_idx on public.candidates using gist (location);
create index if not exists candidates_gid_idx on public.candidates (google_place_id);

create table if not exists public.place_ratings (
  google_place_id   text primary key,
  rating            real,
  user_rating_count int,
  price_level       text,
  opening_hours     jsonb,
  fetched_at        timestamptz not null default now()
);

-- ---------- access ----------
alter table public.app_users        enable row level security;
alter table public.user_shorthand   enable row level security;
alter table public.user_prefs       enable row level security;
alter table public.places           enable row level security;
alter table public.note_extractions enable row level security;
alter table public.visits           enable row level security;
alter table public.captures         enable row level security;
alter table public.feedback         enable row level security;
alter table public.user_profiles    enable row level security;
alter table public.digest_items     enable row level security;
alter table public.feed_items       enable row level security;
alter table public.candidates       enable row level security;
alter table public.place_ratings    enable row level security;

-- scripts (secret key) can do everything
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- signed-in app users: their own rows only
do $$
declare t text;
begin
  foreach t in array array['user_shorthand', 'user_prefs', 'places', 'note_extractions', 'visits',
                           'captures', 'feedback', 'user_profiles', 'digest_items']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

grant select, update on public.app_users to authenticated;
drop policy if exists own_row on public.app_users;
create policy own_row on public.app_users for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant usage on all sequences in schema public to authenticated;

-- shared, read-only
grant select on public.candidates, public.place_ratings to authenticated;
drop policy if exists read_all on public.candidates;
create policy read_all on public.candidates for select to authenticated using (true);
drop policy if exists read_all on public.place_ratings;
create policy read_all on public.place_ratings for select to authenticated using (true);
-- feed_items: no grants, no policies (scripts only)

-- ---------- Nearby ----------
-- The user's own food saves and this user's new picks within radius_m, nearest first.
-- Called by the app as the signed-in user. Scripts (secret key) can pass for_user to test.
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
    where p.user_id = me.uid and p.is_food and p.location is not null
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
