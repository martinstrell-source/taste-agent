# Taste Agent (working title)

A dining-intentions agent seeded from your Google Maps saved lists.
Proves the AI thesis before any mobile build: a taste profiler trained on
real saved places, with a "why now" ranker on top.

## The thesis

Everyone recommends from what you saved. Nobody learns from what you
saved but never visited, from the notes you left ("Eli says meh",
"Almost went with Evan"), or from the moment you're standing somewhere
at 7pm on a Friday. This prototype tests whether that signal is real.

## Pipeline (Supabase, Oct 26 2026)

Everything is per user and lives in Supabase (Postgres + PostGIS). The scripts connect to the database
directly with `SUPABASE_DB_URL`; the iPhone app reads the same tables through the Supabase API, limited
to the signed-in user's rows. `data/taste.db` is the old SQLite database, kept for reference only.

One-time setup on a new machine:

```bash
.venv/bin/pip install "psycopg[binary]" anthropic feedparser certifi
# .env needs: SUPABASE_DB_URL (Supabase > Connect > Session pooler, with the database password),
# SUPABASE_URL, SUPABASE_SECRET_KEY, ANTHROPIC_API_KEY, GOOGLE_MAPS_API_KEY
# Supabase SQL Editor: run schema.sql, then schema_v2.sql, then schema_v3.sql
```

```bash
.venv/bin/python users.py add sam --email sam@example.com --name Sam --home 37.87,-122.27 --label Berkeley
.venv/bin/python ingest.py --user sam ~/Downloads/Takeout/Saved     # every list; favorites count double
.venv/bin/python ingest.py --user sam <newer Saved folder> --dry-run  # later exports: preview new, edited, removed
.venv/bin/python extract.py --user sam --all       # Claude reads notes (dishes, sources, intent)
.venv/bin/python enrich.py --user sam              # Google: location, categories, food or not
.venv/bin/python profile.py --user sam             # -> user_profiles table
.venv/bin/python fetch_sources.py                  # shared: new places from Bay Area food feeds
.venv/bin/python match.py --user sam --explain 10  # -> data/picks/sam.json
.venv/bin/python digest.py --user sam              # -> data/digests/sam-<date>.html (preview) + digest_items
.venv/bin/python feedback.py sam "Place name" love|meh|no|want
.venv/bin/python onboard.py --user dana --email dana@example.com --text "I live in Berkeley. Love ..."
```

`--user` takes the short handle (`martin`); a new user also needs `--email`, which becomes their
Supabase sign-in account.

Files: app/ (the iPhone app, Expo; see app/README.md), common.py (connection, helpers), schema.sql + schema_v2.sql + schema_v3.sql (Supabase tables, run once each),
s2decode.py (approximate location from Takeout ids), migrate_to_supabase.py (one-time copy of the
SQLite data; do not rerun once the scripts write to Supabase, or it will overwrite newer rows with old
ones). migrate_v3.py, rank.py and *_v1.py are superseded and kept for reference.

## Earlier notes


1. **ingest.py** — Takeout `Saved/*.csv` → SQLite. Extracts place ids,
   mines notes for sources (reddit, yelp, chronicle, michelin, people)
   and sentiment (negative, near_miss, neutral). Dedupes by place id.
2. **enrich.py** — Places API (New) Text Search → coordinates, types,
   rating, price level. NOTE: Takeout place ids (`0x…:0x…`) are Google's
   internal feature ids, not Places API ids, so enrichment is title
   search with a fuzzy-match flag. Needs `GOOGLE_MAPS_API_KEY`.
3. **profile.py** — theme affinities, source trust, chain behavior,
   sentiment counts → `data/taste_profile.json`.
4. **rank.py** — "why now" skeleton: taste × proximity × quality,
   top 5 with explanation placeholders. The Claude explainer and the
   per-place theme tags are the next build step.

## Run it

```bash
python3 ingest.py        # CSV -> data/taste.db
python3 profile.py       # -> data/taste_profile.json + summary
# enrichment needs a key:
GOOGLE_MAPS_API_KEY=... python3 enrich.py
python3 rank.py --lat 37.76 --lng -122.46 --when "Friday 7pm"
```

## What's next

- Per-place theme tags stored at ingest/profile time (ranker needs them
  for the real taste score; currently neutral 0.5).
- Claude-powered "why this, why now" explanations.
- Thumbs up/down feedback loop → profile updates (the learning story).
- Share-extension capture design (the app becomes the save point).
- Then, and only then: the Expo mobile build.
