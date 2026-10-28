#!/usr/bin/env python3
"""Weekly discovery of new places, shared by all users (run after fetch_sources.py, before match.py).

Two sources, both stored in the shared candidates table so match.py ranks them for each user
and the app's Nearby shows them as picks:

A) Google by cuisine: for each user's top cuisines (merged across users), search Google
   Places in each sub-region and keep only recent places (opened in the last 2 years by Google's
   date, or under 150 reviews when Google has no date). One search serves every user.
B) Claude with web search: one call per sub-region for new openings and fresh coverage, steered
   toward the cuisines users care about. Each place is matched on Google.

Costs stay flat as users grow: the searches depend on cuisines and regions, not on users.

  python discover.py --dry-run          # show the searches it would run, no API calls
  python discover.py                    # Google and web
  python discover.py --skip-web         # Google only
  python discover.py --regions sf,east  # some sub-regions only

What each run stores:
- feed_items rows with item_id "google:<region>:<query>" or "web:<article url>" (private).
- candidates rows (shared). A Google place that is no longer recent drops out of its search's rows;
  a place that stays keeps its first-seen date (created_at).
- Google rating, review count and price go into the place_ratings cache.
"""
import argparse
import datetime
import json
import os
import re
import urllib.error
import urllib.request

from common import SSL_CTX, cats_list, connect, ensure_schema, is_food_types, jsonb, load_env, name_similarity
from s2decode import haversine_m

TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
SEARCH_FIELDS = ("places.id,places.displayName,places.formattedAddress,places.location,places.types,"
                 "places.primaryType,places.businessStatus,places.rating,places.userRatingCount,"
                 "places.priceLevel,places.googleMapsUri,places.openingDate,nextPageToken")
MATCH_FIELDS = ("places.id,places.displayName,places.formattedAddress,places.location,places.types,"
                "places.primaryType,places.businessStatus,places.googleMapsUri")
BAY_CENTER = (37.7749, -122.2700)
BAY_MAX_KM = 120

# sub-regions: Google searches stay inside the box; the web search is told the area by name
REGIONS = {
    "sf": {"name": "San Francisco and Marin",
           "box": {"low": {"latitude": 37.70, "longitude": -122.62}, "high": {"latitude": 38.10, "longitude": -122.35}}},
    "east": {"name": "the East Bay (Oakland, Berkeley, Alameda, Richmond, Hayward, Fremont, Walnut Creek)",
             "box": {"low": {"latitude": 37.45, "longitude": -122.35}, "high": {"latitude": 38.05, "longitude": -121.75}}},
    "south": {"name": "the Peninsula and South Bay (San Mateo to San Jose)",
              "box": {"low": {"latitude": 37.20, "longitude": -122.55}, "high": {"latitude": 37.70, "longitude": -121.75}}},
}

NEW_YEARS = 2
FEW_REVIEWS = 150
MIN_RATING = 4.2          # once a place has 20+ reviews
MAX_CUISINES = 15
PAGES = 2                 # up to 40 results per search
WEB_MODEL = "claude-sonnet-5-5"
WEB_MAX_SEARCHES = 6
WEB_PLACES = 20

# cuisines too broad to be useful as a Google search on their own
TOO_BROAD = {"american", "asian", "european", "fusion", "cafe", "restaurant", "breakfast", "brunch"}


# ---------- which cuisines to search ----------

PER_USER = 8  # each user's top cuisines that go into the shared searches


def cuisine_interest(con, base_cuisine):
    """Each user's top cuisines (4+ places, at least as common as for a typical diner, strongest first),
    plus cuisines they stated at signup; merged across users, most shared first."""
    score = {}
    for (prof,) in con.execute("SELECT profile FROM user_profiles"):
        prof = prof if isinstance(prof, dict) else json.loads(prof)
        cz = prof.get("cuisines") or {}
        total = sum(v["count"] for v in cz.values()) or 1
        dis = set((prof.get("dislikes") or {}).get("cuisines", []))
        stated = set(prof.get("stated_cuisines") or [])
        mine = []
        for c, v in cz.items():
            if c in TOO_BROAD or c in dis:
                continue
            lift = (v["count"] / total) / base_cuisine.get(c, 0.02)
            if (v["count"] >= 4 and lift >= 1) or c in stated:
                mine.append((lift, c))
        for lift, c in sorted(mine, reverse=True)[:PER_USER]:
            score[c] = score.get(c, 0) + min(lift, 10)
        for c in stated - set(cz) - dis - TOO_BROAD:  # said at signup, nothing saved yet
            score[c] = score.get(c, 0) + 5
    return [c for c, _ in sorted(score.items(), key=lambda x: -x[1])][:MAX_CUISINES]


# ---------- Google ----------

def google_search(query, box, fields, pages=1, n=20):
    out, token, calls = [], None, 0
    for _ in range(pages):
        body = {"textQuery": query, "pageSize": n, "locationRestriction": {"rectangle": box}}
        if token:
            body["pageToken"] = token
        req = urllib.request.Request(TEXT_SEARCH_URL, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "X-Goog-Api-Key": os.environ["GOOGLE_MAPS_API_KEY"],
            "X-Goog-FieldMask": fields})
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            d = json.load(r)
        calls += 1
        out += d.get("places", [])
        token = d.get("nextPageToken")
        if not token:
            break
    return out, calls


def is_recent(p, today):
    d = p.get("openingDate") or {}
    if d.get("year"):
        months = (today.year - d["year"]) * 12 + (today.month - (d.get("month") or 1))
        return months <= NEW_YEARS * 12
    return (p.get("userRatingCount") or 0) < FEW_REVIEWS


def keep(p, today):
    if p.get("businessStatus", "OPERATIONAL") != "OPERATIONAL" or not is_food_types(p.get("types", [])):
        return False
    if not is_recent(p, today):
        return False
    count = p.get("userRatingCount") or 0
    return count < 20 or (p.get("rating") or 0) >= MIN_RATING


def in_bay(loc):
    return bool(loc) and haversine_m(loc["latitude"], loc["longitude"], *BAY_CENTER) <= BAY_MAX_KM * 1000


def save_rating(con, p):
    con.execute("""INSERT INTO place_ratings (google_place_id, rating, user_rating_count, price_level, fetched_at)
                   VALUES (%s,%s,%s,%s,now())
                   ON CONFLICT (google_place_id) DO UPDATE SET rating=excluded.rating,
                     user_rating_count=excluded.user_rating_count, price_level=excluded.price_level,
                     fetched_at=excluded.fetched_at""",
                (p["id"], p.get("rating"), p.get("userRatingCount"), p.get("priceLevel")))


def upsert_item(con, item_id, source, title, link, published):
    con.execute("""INSERT INTO feed_items (item_id, source, title, link, published, fetched_at, status)
                   VALUES (%s,%s,%s,%s,%s,now(),'processing')
                   ON CONFLICT (item_id) DO UPDATE SET source=excluded.source, title=excluded.title,
                     link=excluded.link, published=coalesce(feed_items.published, excluded.published),
                     fetched_at=excluded.fetched_at, status='processing'""",
                (item_id, source, title, link, published))


def upsert_candidate(con, item_id, source, title, link, published, name, hint, mention_type, cuisine,
                     dishes, what_it_says, g, sim, conf, tone="positive"):
    loc = g.get("location") or {}
    types = g.get("types", [])
    # created_at is left alone on update: it is the date the place was first seen
    con.execute(
        """INSERT INTO candidates
           (item_id, source, item_title, item_link, published, name, location_hint, mention_type,
            cuisine, dishes, what_it_says, google_place_id, google_name, address, location,
            categories, primary_type, business_status, maps_uri, name_similarity,
            match_confidence, is_food, in_bay_area, tone)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,pt(%s, %s),%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (item_id, name) DO UPDATE SET
             source=excluded.source, item_title=excluded.item_title, item_link=excluded.item_link,
             location_hint=excluded.location_hint, mention_type=excluded.mention_type,
             cuisine=excluded.cuisine, dishes=excluded.dishes, what_it_says=excluded.what_it_says,
             google_place_id=excluded.google_place_id, google_name=excluded.google_name,
             address=excluded.address, location=excluded.location, categories=excluded.categories,
             primary_type=excluded.primary_type, business_status=excluded.business_status,
             maps_uri=excluded.maps_uri, name_similarity=excluded.name_similarity,
             match_confidence=excluded.match_confidence, is_food=excluded.is_food,
             in_bay_area=excluded.in_bay_area, tone=excluded.tone""",
        (item_id, source, title, link, published, name, hint, mention_type, cuisine, jsonb(dishes or []),
         what_it_says, g["id"], g.get("displayName", {}).get("text", ""), g.get("formattedAddress"),
         loc.get("latitude"), loc.get("longitude"), cats_list(types), g.get("primaryType"),
         g.get("businessStatus"), g.get("googleMapsUri"), sim, conf, is_food_types(types), in_bay(loc), tone))


def run_google(con, cuisines, regions, today):
    calls, stored, dropped = 0, 0, 0
    for rkey in regions:
        region = REGIONS[rkey]
        for c in cuisines:
            label = c.replace("_", " ").replace("/", " or ")
            query = f"{label} restaurant"
            item_id = f"google:{rkey}:{c}"
            try:
                places, n = google_search(query, region["box"], SEARCH_FIELDS, pages=PAGES)
                calls += n
            except urllib.error.HTTPError as e:
                print(f"  Google search failed for {query!r} in {rkey}: {e.code} {e.read().decode()[:200]}")
                continue
            upsert_item(con, item_id, "Google Maps search", f"New {label} places, {region['name']}", None,
                        today)
            kept = []
            for p in places:
                if not keep(p, today):
                    continue
                save_rating(con, p)
                count = p.get("userRatingCount") or 0
                says = (f"A recent {label} place found on Google"
                        + (f", {p['rating']:.1f} stars from {count} reviews" if p.get("rating") and count >= 20
                           else f", {count} reviews so far" if count else "") + ".")
                upsert_candidate(con, item_id, "Google Maps search", f"New {label} places", p.get("googleMapsUri"),
                                 today, p["displayName"]["text"], region["name"], "discovery", c, [], says,
                                 p, 1.0, "good", tone="neutral")
                kept.append(p["displayName"]["text"])
            # places no longer recent (or closed) leave this search's rows; the rest keep their first-seen date
            if kept:
                r = con.execute("DELETE FROM candidates WHERE item_id=%s AND NOT (name = ANY(%s))", (item_id, kept))
            else:
                r = con.execute("DELETE FROM candidates WHERE item_id=%s", (item_id,))
            dropped += r.rowcount or 0
            con.execute("UPDATE feed_items SET n_places=%s, status='done' WHERE item_id=%s", (len(kept), item_id))
            con.commit()
            stored += len(kept)
            print(f"  {rkey:5} {query:40} {len(places):3} found, {len(kept):3} recent")
    return calls, stored, dropped


# ---------- Claude with web search ----------

WEB_PROMPT = """Find new and newly covered food and drink places in {region}, California.

Look for restaurants, cafes, bakeries, dessert shops and bars that opened in the last six months,
or got fresh coverage in that time (reviews, "best new" lists, opening news). Use local food press:
newspapers, neighborhood news sites, The Infatuation, Eater, Resy, local blogs.
Our users especially like these cuisines, so search for some of them too: {cuisines}.
Skip chains and famous standbys. Places must be open now (or opening within a month).

Return up to {n} places. End your answer with a JSON array in a ```json block, one object per place:
{{"name": "...", "city": "...", "cuisine": "...", "dishes": ["..."],
  "mention_type": "opening" | "review" | "list_entry" | "news",
  "what_it_says": "one factual sentence in your own words: what the place is and what is notable. No quotes from articles, no opinions copied from critics.",
  "source": "publication name", "source_title": "article title", "source_url": "...", "published": "YYYY-MM-DD or YYYY-MM or empty"}}"""


def claude_web(region_name, cuisines):
    body = {
        "model": WEB_MODEL,
        "max_tokens": 16000,
        "messages": [{"role": "user", "content": WEB_PROMPT.format(region=region_name, n=WEB_PLACES,
                                                                    cuisines=", ".join(cuisines) or "any")}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": WEB_MAX_SEARCHES,
                   "user_location": {"type": "approximate", "city": "San Francisco", "region": "California",
                                     "country": "US", "timezone": "America/Los_Angeles"}}],
    }
    searches, tin, tout = 0, 0, 0
    resp = None
    for _ in range(4):  # a long search turn can pause; send it back to continue
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
            "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=600, context=SSL_CTX) as r:
            resp = json.load(r)
        u = resp.get("usage", {})
        tin += u.get("input_tokens", 0)
        tout += u.get("output_tokens", 0)
        searches += u.get("server_tool_use", {}).get("web_search_requests", 0)
        if resp.get("stop_reason") == "pause_turn":
            body["messages"] = [body["messages"][0], {"role": "assistant", "content": resp["content"]}]
            continue
        break
    text = "".join(b.get("text", "") for b in resp["content"] if b.get("type") == "text")
    blocks = re.findall(r"```json\s*(.*?)```", text, re.S)
    try:
        items = json.loads(blocks[-1]) if blocks else []
    except json.JSONDecodeError:
        items = []
    return items, searches, tin, tout


def parse_date(s):
    for fmt in ("%Y-%m-%d", "%Y-%m"):
        try:
            return datetime.datetime.strptime((s or "").strip(), fmt).date()
        except ValueError:
            pass
    return None


def run_web(con, cuisines, regions, today):
    total_cost, stored, unmatched, searches_all, gcalls = 0.0, 0, 0, 0, 0
    for rkey in regions:
        region = REGIONS[rkey]
        try:
            items, searches, tin, tout = claude_web(region["name"], cuisines)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            print(f"  web search failed for {rkey}: HTTP {e.code} {msg}")
            if "web search" in msg.lower() and "disabled" in msg.lower():
                print("  Web search is turned off for this Anthropic workspace. Turn it on in the Claude Console.")
            continue
        cost = searches * 0.01 + tin * 3e-6 + tout * 15e-6
        total_cost += cost
        searches_all += searches
        n_region = 0
        for it in items:
            name, city = (it.get("name") or "").strip(), (it.get("city") or "").strip()
            url = (it.get("source_url") or "").strip()
            if not name or not url.startswith("http"):
                continue
            try:
                res, n = google_search(f"{name} {city}", region["box"], MATCH_FIELDS, n=5)
                gcalls += n
            except urllib.error.HTTPError:
                res = []
            best = max(res, key=lambda p: name_similarity(name, p["displayName"]["text"]), default=None)
            sim = name_similarity(name, best["displayName"]["text"]) if best else 0
            if not best or sim < 0.6:
                unmatched += 1
                continue
            if best.get("businessStatus", "OPERATIONAL") != "OPERATIONAL":
                continue
            item_id = f"web:{url}"
            published = parse_date(it.get("published"))
            src = (it.get("source") or "Web").strip()
            upsert_item(con, item_id, src, it.get("source_title") or src, url, published)
            mtype = it.get("mention_type") if it.get("mention_type") in ("opening", "review", "list_entry", "news") else "news"
            upsert_candidate(con, item_id, src, it.get("source_title") or src, url, published, name, city, mtype,
                             (it.get("cuisine") or "").lower() or None, it.get("dishes") or [],
                             (it.get("what_it_says") or "").strip()[:300], best, round(sim, 3),
                             "good" if sim >= 0.8 else "ok")
            con.execute("UPDATE feed_items SET status='done', n_places=coalesce(n_places,0)+1 WHERE item_id=%s",
                        (item_id,))
            n_region += 1
        con.commit()
        stored += n_region
        print(f"  {rkey:5} web: {len(items)} suggested, {n_region} stored, {searches} searches, about ${cost:.2f}")
    return stored, unmatched, searches_all, gcalls, total_cost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--regions", default=",".join(REGIONS), help="comma list of: " + ", ".join(REGIONS))
    ap.add_argument("--skip-web", action="store_true")
    ap.add_argument("--skip-google", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="show the searches, no API calls")
    args = ap.parse_args()
    regions = [r.strip() for r in args.regions.split(",") if r.strip()]
    bad = [r for r in regions if r not in REGIONS]
    if bad:
        raise SystemExit(f"Unknown region(s): {', '.join(bad)}. Use: {', '.join(REGIONS)}")

    load_env()
    con = connect()
    ensure_schema(con)
    from match import BASE_CUISINE
    cuisines = cuisine_interest(con, BASE_CUISINE)
    today = datetime.date.today()
    print(f"Cuisines to search ({len(cuisines)}, from all users' profiles): {', '.join(cuisines) or 'none'}")
    print(f"Regions: {', '.join(regions)}")
    if args.dry_run:
        print(f"Would run about {len(cuisines) * len(regions) * PAGES} Google searches (rating fields) and "
              f"{0 if args.skip_web else len(regions)} web search calls (up to {WEB_MAX_SEARCHES} searches each).")
        return

    if not args.skip_google:
        print("\nGoogle by cuisine (recent places only):")
        calls, stored, dropped = run_google(con, cuisines, regions, today)
        print(f"Google: {calls} searches, {stored} recent places stored, {dropped} dropped as no longer recent")
    if not args.skip_web:
        print("\nClaude with web search (a minute or two per region):")
        stored, unmatched, searches, gcalls, cost = run_web(con, cuisines, regions, today)
        print(f"Web: {stored} places stored, {unmatched} not found on Google, {searches} web searches, "
              f"{gcalls} Google lookups, about ${cost:.2f}")
    n = con.execute("SELECT count(DISTINCT google_place_id) FROM candidates WHERE is_food AND in_bay_area "
                    "AND (item_id LIKE 'google:%%' OR item_id LIKE 'web:%%')").fetchone()[0]
    print(f"\nDiscovery places in the shared pool now: {n}. Next: match.py for each user.")


if __name__ == "__main__":
    main()
