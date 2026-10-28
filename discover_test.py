#!/usr/bin/env python3
"""Test two new sources of picks for one user, without changing anything in the database.

A) Google by taste: search Google Places across the Bay Area for the user's most distinctive cuisines,
   keep only places opened in the last 2 years (Google's opening date, or few reviews when there is
   none), drop places they already saved or reacted to, rank by fit and rating.
B) Claude with web search: Claude searches the web for Bay Area places that fit the user's taste,
   preferring recent openings and coverage; each is matched on Google and checked against their saves.

  python discover_test.py --user martin                 # writes data/discover-test-<user>.txt
  python discover_test.py --user martin --skip-web      # Google only

Read-only: nothing is written to Supabase. Costs: up to about 27 Google searches with rating fields
(free tier), up to 8 web searches ($10 per 1,000) plus one Claude call.
"""
import argparse
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from common import SSL_CTX, connect, ensure_schema, get_user, is_food_types, lat_sql, lng_sql, load_env, name_similarity, norm
from match import BASE_CUISINE, PRICE, load_profile
from s2decode import haversine_m

ROOT = Path(__file__).parent
TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
# rough Bay Area box (Santa Rosa to San Jose, coast to Livermore)
BAY = {"low": {"latitude": 37.20, "longitude": -122.65}, "high": {"latitude": 38.50, "longitude": -121.65}}
FIELDS = ("places.id,places.displayName,places.formattedAddress,places.location,places.types,"
          "places.businessStatus,places.rating,places.userRatingCount,places.priceLevel,places.googleMapsUri,"
          "places.openingDate,nextPageToken")
NEW_YEARS = 2          # Google search (A): only places opened within this many years...
FEW_REVIEWS = 150      # ...or, when Google has no opening date, with fewer reviews than this (likely new)
WEB_MODEL = "claude-sonnet-5-5"


def google_search(query, rating_fields=True, n=20, pages=1):
    """Text Search in the Bay Area box. pages > 1 follows Google's next-page token (up to 60 results)."""
    mask = FIELDS if rating_fields else "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus,places.googleMapsUri,places.openingDate"
    out, token, calls = [], None, 0
    for _ in range(pages):
        body = {"textQuery": query, "pageSize": n, "locationRestriction": {"rectangle": BAY}}
        if token:
            body["pageToken"] = token
        req = urllib.request.Request(TEXT_SEARCH_URL, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "X-Goog-Api-Key": os.environ["GOOGLE_MAPS_API_KEY"],
            "X-Goog-FieldMask": mask})
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            d = json.load(r)
        calls += 1
        out += d.get("places", [])
        token = d.get("nextPageToken")
        if not token:
            break
    google_search.calls = getattr(google_search, "calls", 0) + calls
    return out


def opened(p):
    """(year, month) Google says the place opened, or None."""
    d = p.get("openingDate") or {}
    return (d["year"], d.get("month") or 1) if d.get("year") else None


def recent(p, today):
    """Opened within NEW_YEARS (by Google's date), or few reviews when there is no date."""
    o = opened(p)
    if o:
        return (today[0] - o[0]) * 12 + (today[1] - o[1]) <= NEW_YEARS * 12, "date"
    return (p.get("userRatingCount") or 0) < FEW_REVIEWS, "reviews"


def city_of(address):
    parts = [x.strip() for x in (address or "").split(",")]
    return parts[-3] if len(parts) >= 3 else (parts[0] if parts else "")


def quality(rating, count):
    """Rating pulled toward 4.2 when there are few reviews (so 5.0 from 3 reviews doesn't win)."""
    if not rating:
        return 0.0
    k = 30
    return (rating * (count or 0) + 4.2 * k) / ((count or 0) + k)


class Known:
    """What the user already knows: saved places (by Google id or same name nearby) and reactions."""

    def __init__(self, con, uid):
        self.ids = {r[0] for r in con.execute(
            "SELECT google_place_id FROM places WHERE user_id=%s AND google_place_id IS NOT NULL", (uid,))}
        self.ids |= {r[0] for r in con.execute("SELECT google_place_id FROM feedback WHERE user_id=%s", (uid,))}
        self.named = [(norm(t or ""), norm(g or ""), la, ln) for t, g, la, ln in con.execute(
            f"SELECT title, google_name, {lat_sql('location')}, {lng_sql('location')} FROM places "
            "WHERE user_id=%s AND location IS NOT NULL", (uid,))]
        self.pick_ids = {r[0] for r in con.execute(
            "SELECT DISTINCT google_place_id FROM candidates WHERE google_place_id IS NOT NULL")}

    def __contains__(self, p):
        if p["id"] in self.ids:
            return True
        n = norm(p.get("displayName", {}).get("text", ""))
        loc = p.get("location") or {}
        for t, g, la, ln in self.named:
            if n and (n == t or n == g) and loc and haversine_m(loc["latitude"], loc["longitude"], la, ln) < 300:
                return True
        return False


def taste_queries(prof):
    """The user's most distinctive cuisines (vs a typical diner) and most repeated dishes."""
    total = sum(v["count"] for v in prof["cuisines"].values()) or 1
    dis = set((prof.get("dislikes") or {}).get("cuisines", []))
    lifted = []
    for c, v in prof["cuisines"].items():
        if v["count"] < 4 or c in dis:
            continue
        lift = (v["count"] / total) / BASE_CUISINE.get(c, 0.02)
        lifted.append((lift, c, v["count"]))
    lifted.sort(reverse=True)
    cuisines = [(c, lift) for lift, c, _ in lifted[:9]]
    dishes = [(d, v) for d, v in sorted(prof["dishes"].items(), key=lambda x: -x[1])
              if v >= 2 and len(d) > 3][:6]
    return cuisines, dishes


def run_google(prof, known, home):
    import datetime
    t = datetime.date.today()
    today = (t.year, t.month)
    cuisines, _ = taste_queries(prof)  # dish words alone were too broad (ice cream, pizza): cuisines only
    queries = [(f"{c.replace('_', ' ')} restaurant", f"you save a lot of {c.replace('_', ' ')} ({lift:.0f}x a typical diner)",
                min(lift, 8) / 8) for c, lift in cuisines]
    found, seen, how = {}, 0, {"date": 0, "reviews": 0}
    google_search.calls = 0
    for q, reason, weight in queries:
        try:
            places = google_search(q, pages=3)
        except urllib.error.HTTPError as e:
            print(f"  Google search failed for {q!r}: {e.code} {e.read().decode()[:200]}")
            continue
        for rank, p in enumerate(places):
            if p.get("businessStatus", "OPERATIONAL") != "OPERATIONAL" or not is_food_types(p.get("types", [])):
                continue
            if p in known:
                continue
            seen += 1
            is_new, basis = recent(p, today)
            if not is_new:
                continue
            how[basis] += 1
            count = p.get("userRatingCount") or 0
            if count >= 20 and (p.get("rating") or 0) < 4.3:
                continue
            fit = weight * (1 - rank / 25)
            loc = p.get("location") or {}
            near = 0.0
            if home and loc:
                near = max(0.0, 1 - haversine_m(home[0], home[1], loc["latitude"], loc["longitude"]) / 40000)
            score = 0.55 * fit + 0.35 * (quality(p.get("rating"), count) - 4.0) + 0.10 * near
            cur = found.get(p["id"])
            if cur is None or score > cur["score"]:
                found[p["id"]] = {"place": p, "score": score, "why": reason, "query": q}
            elif reason not in cur["why"]:
                cur["why"] += f"; {reason}"
                cur["score"] += 0.05
    ranked = sorted(found.values(), key=lambda x: -x["score"])
    # keep it varied: at most 3 from any one search
    out, per_query = [], {}
    for r in ranked:
        if per_query.get(r["query"], 0) >= 3:
            continue
        per_query[r["query"]] = per_query.get(r["query"], 0) + 1
        out.append(r)
        if len(out) == 15:
            break
    stats = f"{seen} unsaved food places found, {sum(how.values())} recent ({how['date']} by Google's opening date, {how['reviews']} by few reviews)"
    return out, google_search.calls, [q for q, _, _ in queries], stats


def claude_web(prof, user):
    """One Claude call with web search; returns (places, searches used, usage)."""
    cuisines, dishes = taste_queries(prof)
    dis = prof.get("dislikes") or {}
    taste = {
        "lives in": user.get("home_label") or "the Bay Area",
        "most distinctive cuisines (saves much more than a typical diner)": [c for c, _ in cuisines],
        "top cuisines overall": list(prof["cuisines"])[:12],
        "kinds of place": list(prof["formats"])[:6],
        "dishes in their notes": list(prof["dishes"])[:25],
        "trusted sources": [s["name"] for s in prof["sources"][:8]],
        "dislikes": {k: v for k, v in dis.items() if v},
    }
    prompt = f"""Find Bay Area restaurants, cafes, bakeries or bars this person would want to try.

Their taste, from about 1,300 places they saved on Google Maps:
{json.dumps(taste, indent=2)}

Search the web. Prefer places that opened or got press in the last six months, then lesser-known
places that fit their distinctive cuisines and dishes. Skip famous standbys most Bay Area food
people already know. Bay Area only (SF, East Bay, Peninsula, South Bay, Marin). Places must be open now.

Return 20 places. End your answer with a JSON array in a ```json block, one object per place:
{{"name": "...", "city": "...", "cuisine": "...",
  "why": "one sentence in your own words on why it fits this person (no quotes from articles)",
  "source_title": "...", "source_url": "...", "published": "YYYY-MM or empty"}}"""
    body = {
        "model": WEB_MODEL,
        "max_tokens": 16000,
        "messages": [{"role": "user", "content": prompt}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8,
                   "user_location": {"type": "approximate", "city": "San Francisco", "region": "California",
                                     "country": "US", "timezone": "America/Los_Angeles"}}],
    }
    searches, usage = 0, {"input_tokens": 0, "output_tokens": 0}
    for _ in range(4):  # the API may pause a long search turn; send it back to continue
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
            "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600, context=SSL_CTX) as r:
                resp = json.load(r)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:400]
            raise SystemExit(f"Claude web search failed: HTTP {e.code} {msg}\n"
                             "If it says web search is disabled, turn it on in the Claude Console "
                             "(Settings > Privacy / Web search) or run with --skip-web.")
        for k in usage:
            usage[k] += resp.get("usage", {}).get(k, 0)
        searches += resp.get("usage", {}).get("server_tool_use", {}).get("web_search_requests", 0)
        if resp.get("stop_reason") == "pause_turn":
            body["messages"] = [body["messages"][0], {"role": "assistant", "content": resp["content"]}]
            continue
        break
    text = "".join(b.get("text", "") for b in resp["content"] if b.get("type") == "text")
    m = re.findall(r"```json\s*(.*?)```", text, re.S)
    try:
        places = json.loads(m[-1]) if m else []
    except json.JSONDecodeError:
        places = []
    if not places:
        print("Claude returned no usable list. Its answer started:\n" + text[:800])
    return places, searches, usage


def resolve_web(items, known):
    """Match each web suggestion on Google; drop unknown, closed, non-food and already-saved places."""
    out, calls, dropped = [], 0, {"no match": 0, "already saved": 0, "closed or not food": 0}
    for it in items:
        q = f"{it.get('name', '')} {it.get('city', '')}".strip()
        try:
            res = google_search(q, n=5)
            calls += 1
        except urllib.error.HTTPError:
            dropped["no match"] += 1
            continue
        best = max(res, key=lambda p: name_similarity(it.get("name", ""), p["displayName"]["text"]), default=None)
        if not best or name_similarity(it.get("name", ""), best["displayName"]["text"]) < 0.6:
            dropped["no match"] += 1
            continue
        if best.get("businessStatus", "OPERATIONAL") != "OPERATIONAL" or not is_food_types(best.get("types", [])):
            dropped["closed or not food"] += 1
            continue
        if best in known:
            dropped["already saved"] += 1
            continue
        out.append({"place": best, "item": it})
    return out, calls, dropped


def fmt_place(p):
    count = p.get("userRatingCount") or 0
    rating = (f"New: {count} reviews" if count < 20 else f"{p['rating']:.1f} stars, {count:,} reviews") if p.get("rating") else "no rating yet"
    o = opened(p)
    if o:
        rating += f", opened {o[1]}/{o[0]}"
    price = PRICE.get(p.get("priceLevel") or "", "")
    types = [t.replace("_restaurant", "").replace("_", " ") for t in p.get("types", [])
             if t not in ("restaurant", "food", "point_of_interest", "establishment", "store")][:3]
    return (f"{p['displayName']['text']}, {city_of(p.get('formattedAddress'))} ({', '.join(types)})\n"
            f"   {rating}{', ' + price if price else ''}. {p.get('formattedAddress', '')}\n"
            f"   {p.get('googleMapsUri', '')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--skip-web", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()
    load_env()
    con = connect()
    ensure_schema(con)
    user = get_user(con, args.user)
    prof = load_profile(con, user)
    known = Known(con, user["uid"])
    lines = []

    g, g_calls, queries, stats = run_google(prof, known, user["home"])
    lines.append(f"A) GOOGLE BY TASTE, OPENED IN THE LAST {NEW_YEARS} YEARS: {len(g)} places ({g_calls} Google searches)")
    lines.append("   " + stats)
    lines.append("   searches: " + ", ".join(queries) + "\n")
    for i, r in enumerate(g, 1):
        tag = "  [also a current pick]" if r["place"]["id"] in known.pick_ids else ""
        lines.append(f"{i}. {fmt_place(r['place'])}{tag}\n   why: {r['why']}\n")

    if not args.skip_web:
        print("Asking Claude to search the web (takes a minute or two)...")
        items, searches, usage = claude_web(prof, user)
        w, w_calls, dropped = resolve_web(items, known)
        cost = searches * 0.01 + usage["input_tokens"] * 3e-6 + usage["output_tokens"] * 15e-6
        lines.append(f"\nB) CLAUDE WITH WEB SEARCH: {len(items)} suggested, {len(w)} new to you "
                     f"(dropped: {', '.join(f'{v} {k}' for k, v in dropped.items() if v) or 'none'}). "
                     f"{searches} web searches, {w_calls} Google lookups, about ${cost:.2f}\n")
        for i, r in enumerate(w, 1):
            it = r["item"]
            tag = "  [also a current pick]" if r["place"]["id"] in known.pick_ids else ""
            lines.append(f"{i}. {fmt_place(r['place'])}{tag}\n   why: {it.get('why', '')}\n"
                         f"   source: {it.get('source_title', '')} {it.get('published', '')} {it.get('source_url', '')}\n")

    out = Path(args.out) if args.out else ROOT / "data" / f"discover-test-{args.user}.txt"
    out.write_text("\n".join(lines))
    print("\n".join(lines))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
