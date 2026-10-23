# Taste Agent

A prototype that learns what kind of food places someone likes and sends them a weekly email of
new Bay Area places that fit, each with enough information to decide: where it is, what it
serves, what critics and Google reviewers say, and one line on why it fits them.

Built as a working prototype for a small group of testers (October 2026).

## How it works

```
your taste                            this week's food coverage
  Google Maps lists (Takeout)            Eater SF, SFist, SF Standard, Tablehopper (RSS)
  or a few sentences at signup           food newsletters (IMAP inbox)
        |                                        |
  Claude reads notes / description       Claude lists every place each article names,
  Google matches places                  with dishes, tone, opening/closing/review
        |                                        |
     taste profile  -------- match.py --------  candidates (matched on Google)
                                 |
                       digest.py: weekly email
                                 |
                       reactions (want / loved it / meh / not for me) feed back in
```

| Script | What it does |
|---|---|
| `users.py` | Add a user: home location, email, personal shorthand ("J" = a friend named Jordan) |
| `ingest.py` | Load Google Takeout saved lists (Want to go, Favorites, custom lists) |
| `onboard.py` | Start a user from a few sentences instead of Takeout; Claude turns it into structure |
| `extract.py` | Claude reads each saved place's note: dishes, who recommended it, intent, sentiment |
| `enrich.py` | Match saves to Google Places; flag non-food places |
| `profile.py` | Build a per-user taste profile (cuisines, kinds of place, dishes, trusted sources, dislikes) |
| `fetch_sources.py` | Pull new articles and newsletters; Claude extracts the places; match them on Google |
| `match.py` | Score candidates against a profile; skip places the user already knows |
| `digest.py` | Build the weekly email |
| `feedback.py` | Record a reaction to a place |

## Design notes

**Takeout place ids are not Places API ids.** A Takeout save carries Google's internal feature id
(`0x808f...:0x...`). The first half is an S2 cell id, so `s2decode.py` decodes an approximate
location (usually within a few km) with no API call. Searching by name *biased to that location*
fixed most wrong matches: chain branches stopped collapsing onto one location (69 shared matches
down to 23, most of those true duplicate saves) and "Nijō Castle" stopped matching a Fremont sushi bar.

**Messy notes need entity resolution.** Notes say "SF Chron", "Chronicle", "Merc", or a single
initial for a person. Claude extracts sources and normalizes names; per-user shorthand lives in
the database, not in code, so the pipeline works for any user.

**Cuisine from names.** Google files many regional cuisines under generic types (a Uyghur place
comes back as "chinese" or "halal"), so place names are checked for about 20 regional cuisines.

**Scoring.** Each candidate is scored on how distinctive its cuisine and kind of place are for this
user compared with a typical Bay Area diner, dish overlap, how much the user trusts the source,
whether it is an opening/review/list entry, distance from home, and the article's tone (a pan cuts
the score). Stated dislikes push matching places down. A Claude rerank using notes and reactions is
the planned next step.

**Cost control.** Google Places fields are chosen to stay in the free tiers (Pro fields for matching;
rating and review count, which are pricier, only for the ~10 places shown each week, cached 30 days).
Feed extraction uses Sonnet because it runs once per article and is shared by all users; per-user
note extraction can use Haiku.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # add your keys
.venv/bin/python users.py add alex --name Alex --home 37.87,-122.27 --label Berkeley --email alex@example.com
.venv/bin/python onboard.py --user alex --text "Love Burmese and Oaxacan food, good coffee. Favorites: ..."
#   or: ingest.py --user alex ~/Downloads/Takeout/Saved && extract.py --user alex --all && enrich.py --user alex
.venv/bin/python profile.py --user alex
.venv/bin/python fetch_sources.py
.venv/bin/python digest.py --user alex
```

Data lives in a local SQLite file (`data/taste.db`), which is not in this repository.

## Privacy

Personal data (saved places, notes, profiles, digests, API keys) stays local and is excluded by
`.gitignore`. From articles and newsletters, only place names, links and one-line summaries are kept.
