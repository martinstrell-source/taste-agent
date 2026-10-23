#!/usr/bin/env python3
"""Enrich saved places with location, Google categories, and a food/not-food flag (v2).

v1 searched Google by name only and took the top hit, so chain branches collapsed onto one
location and some names matched the wrong place entirely. v2:

1. Decodes an approximate location from the Takeout feature id (see s2decode.py). It is
   region-accurate (usually within a few km), which is enough to tell San Diego from Fremont.
2. Searches Google by name, biased to that area, and picks the candidate whose name matches
   best, breaking ties by distance to the decoded point.
3. Flags non-food places (from the Claude extraction when a note exists, else from Google types).
   Non-food saves are kept in the table but flagged is_food=0; nothing is deleted.

Places the extraction already marked not_food are not sent to Google (saves calls).

Needs GOOGLE_MAPS_API_KEY in .env (Places API (New) enabled). Pro-tier fields only.
Usage:
    python enrich.py --user alex           # every place of this user not yet enriched with v2
    python enrich.py --user alex --redo    # re-run v2 on all of this user's places
"""
import argparse
import json
import os
import sys
import time
import urllib.request

from common import (SSL_CTX, connect, ensure_schema, get_user, is_food_types, load_env,  # noqa: F401
                    name_similarity, norm)
from s2decode import feature_id_to_latlng, haversine_m

VERSION = 2
BIAS_RADIUS_M = 25000.0
TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"


def search(title, lat, lng):
    body = {"textQuery": title, "maxResultCount": 10}
    if lat is not None:
        body["locationBias"] = {"circle": {"center": {"latitude": lat, "longitude": lng},
                                           "radius": BIAS_RADIUS_M}}
    req = urllib.request.Request(
        TEXT_SEARCH_URL,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": os.environ["GOOGLE_MAPS_API_KEY"],
            "X-Goog-FieldMask": "places.id,places.displayName,places.location,"
                                "places.types,places.formattedAddress",
        },
    )
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        return json.load(resp).get("places", [])


def pick(title, approx, candidates):
    """Best name match; among close name matches, the one nearest the decoded point."""
    scored = []
    for p in candidates:
        sim = name_similarity(title, p.get("displayName", {}).get("text", ""))
        loc = p.get("location") or {}
        dist = (haversine_m(approx[0], approx[1], loc["latitude"], loc["longitude"])
                if approx and loc else None)
        scored.append((sim, dist, p))
    best_sim = max(s for s, _, _ in scored)
    close = [x for x in scored if x[0] >= best_sim - 0.05]
    close.sort(key=lambda x: x[1] if x[1] is not None else 1e12)
    sim, dist, p = close[0]
    if sim >= 0.8 and (dist is None or dist <= 15000):
        conf = "good"
    elif sim >= 0.6 and (dist is None or dist <= 50000):
        conf = "ok"
    else:
        conf = "weak"
    return p, sim, dist, conf


COLUMNS = [  # kept for databases created before common.SCHEMA"lat REAL", "lng REAL", "categories TEXT", "rating REAL", "price_level TEXT",
           "google_place_id TEXT", "match_confidence TEXT", "approx_lat REAL", "approx_lng REAL",
           "google_name TEXT", "address TEXT", "name_similarity REAL", "match_distance_m REAL",
           "is_food INTEGER", "enrich_version INTEGER"]


def ensure_columns(con):
    have = {r[1] for r in con.execute("PRAGMA table_info(places)")}
    for coldef in COLUMNS:
        if coldef.split()[0] not in have:
            con.execute(f"ALTER TABLE places ADD COLUMN {coldef}")
    con.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--db")
    ap.add_argument("--redo", action="store_true")
    args = ap.parse_args()

    load_env()
    if not os.environ.get("GOOGLE_MAPS_API_KEY"):
        sys.exit("Set GOOGLE_MAPS_API_KEY in .env first.")

    con = connect(args.db)
    ensure_schema(con)
    ensure_columns(con)
    get_user(con, args.user)
    extract_kind = dict(con.execute("SELECT place_id, kind FROM note_extractions WHERE user_id=?", (args.user,)))

    q = "SELECT id, place_id, title FROM places WHERE user_id = ?"
    if not args.redo:
        q += f" AND coalesce(enrich_version, 0) < {VERSION}"
    rows = con.execute(q, (args.user,)).fetchall()
    print(f"{len(rows)} places to enrich (v{VERSION})")

    calls = 0
    for n, (rid, pid, title) in enumerate(rows):
        approx = feature_id_to_latlng(pid)
        alat, alng = approx if approx else (None, None)
        kind = extract_kind.get(pid)

        if kind == "not_food":
            con.execute(
                """UPDATE places SET approx_lat=?, approx_lng=?, lat=?, lng=?, is_food=0,
                   match_confidence='skipped_not_food', enrich_version=? WHERE id=?""",
                (alat, alng, alat, alng, VERSION, rid))
            continue

        try:
            calls += 1
            cands = search(title, alat, alng)
        except Exception as e:  # noqa: BLE001 - record and keep going; rerun retries it
            print(f"  error on {title!r}: {e}")
            continue

        if not cands:
            food = None if kind in (None, "unknown") else 1
            con.execute(
                """UPDATE places SET approx_lat=?, approx_lng=?, lat=?, lng=?, categories=NULL,
                   google_place_id=NULL, google_name=NULL, address=NULL, name_similarity=NULL,
                   match_distance_m=NULL, is_food=?, match_confidence='no_match', enrich_version=?
                   WHERE id=?""",
                (alat, alng, alat, alng, food, VERSION, rid))
        else:
            p, sim, dist, conf = pick(title, approx, cands)
            types = p.get("types", [])
            if kind and kind not in ("unknown", "not_food"):
                food = 1
            else:
                food = 1 if is_food_types(types) else 0
            loc = p["location"]
            con.execute(
                """UPDATE places SET approx_lat=?, approx_lng=?, lat=?, lng=?, categories=?,
                   rating=NULL, price_level=NULL, google_place_id=?, google_name=?, address=?,
                   name_similarity=?, match_distance_m=?, is_food=?, match_confidence=?,
                   enrich_version=? WHERE id=?""",
                (alat, alng, loc["latitude"], loc["longitude"], ",".join(types), p.get("id"),
                 p.get("displayName", {}).get("text", ""), p.get("formattedAddress"),
                 round(sim, 3), round(dist) if dist is not None else None, food, conf,
                 VERSION, rid))
        if n % 25 == 0:
            con.commit()
            print(f"  {n}/{len(rows)}")
        time.sleep(0.05)
    con.commit()

    print(f"\nGoogle calls this run: {calls}")
    u = (args.user,)
    for row in con.execute("SELECT match_confidence, count(*) FROM places WHERE user_id=? GROUP BY 1 "
                           "ORDER BY 2 DESC", u):
        print(f"  {row[0]}: {row[1]}")
    food = con.execute("SELECT coalesce(is_food, -1), count(*) FROM places WHERE user_id=? GROUP BY 1", u).fetchall()
    print("  food / not food / unknown:", {1: 0, 0: 0, -1: 0} | dict(food))
    shared = con.execute("""SELECT count(*) FROM (SELECT google_place_id FROM places WHERE user_id=?
                            AND google_place_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1)""", u).fetchone()[0]
    print(f"  Google places matched by more than one save: {shared}")
    con.close()


if __name__ == "__main__":
    main()
