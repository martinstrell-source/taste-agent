#!/usr/bin/env python3
"""Start a user from a few sentences instead of a Google Maps export.

The user writes, in any form: favorite places, cuisines and dishes they love, kinds of place
(coffee, bakeries, bars...), sources they trust, things they don't like, and roughly where they live.
Claude turns that into structure; favorite places are matched on Google near their home and stored
as favorites; the rest goes into user_prefs. profile.py, match.py and digest.py then work as usual.
A Takeout import can be added later and merges with this.

  python onboard.py --user dana --name Dana --text "I live in Berkeley. Love Burma Superstar, ..."
  python onboard.py --user dana --file dana.txt
"""
import argparse
import json
import os
import sys
import time

import anthropic

from common import connect, ensure_schema, is_food_types, load_env
from enrich import pick, search

MODEL = "claude-sonnet-5-5"
FORMATS = ["coffee", "tea", "bakery", "dessert", "bar", "market", "cafe", "fine_dining", "casual"]
SOURCE_TYPES = ["publication", "person", "community", "creator", "app"]

SYSTEM = """A new user of a restaurant recommendation app described their taste in their own words.
Turn it into structure. Use only what they said; do not add cuisines or places they did not mention.

- places: specific restaurants, cafes, bars or shops they named as favorites, with any area or city they gave.
- cuisines: cuisines they like, as short lowercase labels ("burmese", "oaxacan", "sichuan", "pizza").
- dishes: specific dishes or drinks they like ("tea leaf salad", "mole", "cortado").
- formats: kinds of place they like, from this list only: coffee, tea, bakery, dessert, bar, market, cafe, fine_dining, casual.
- sources: where they get recommendations (publications, friends, forums, creators, apps), with a type.
- dislikes: cuisines, dishes, kinds of place (same list as formats) and anything else they said they avoid.
- home_area: where they live or mostly eat, if they said.

Always respond by calling the record tool exactly once."""

TOOL = {
    "name": "record",
    "description": "Record the user's stated taste.",
    "input_schema": {
        "type": "object",
        "properties": {
            "places": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "area": {"type": "string"}}, "required": ["name", "area"]}},
            "cuisines": {"type": "array", "items": {"type": "string"}},
            "dishes": {"type": "array", "items": {"type": "string"}},
            "formats": {"type": "array", "items": {"type": "string", "enum": FORMATS}},
            "sources": {"type": "array", "items": {"type": "object", "properties": {
                "type": {"type": "string", "enum": SOURCE_TYPES}, "name": {"type": "string"}},
                "required": ["type", "name"]}},
            "dislikes": {"type": "object", "properties": {
                "cuisines": {"type": "array", "items": {"type": "string"}},
                "dishes": {"type": "array", "items": {"type": "string"}},
                "formats": {"type": "array", "items": {"type": "string", "enum": FORMATS}},
                "other": {"type": "array", "items": {"type": "string"}}},
                "required": ["cuisines", "dishes", "formats", "other"]},
            "home_area": {"type": "string"},
        },
        "required": ["places", "cuisines", "dishes", "formats", "sources", "dislikes", "home_area"],
    },
}


def parse_taste(text):
    client = anthropic.Anthropic()
    for attempt in range(3):
        r = client.messages.create(model=MODEL, max_tokens=3000, system=SYSTEM, tools=[TOOL],
                                   tool_choice={"type": "auto"}, messages=[{"role": "user", "content": text}])
        block = next((b for b in r.content if b.type == "tool_use"), None)
        if block is not None:
            return block.input
        time.sleep(1)
    raise SystemExit("Could not parse the description; try rephrasing.")


def geocode(area):
    """Center of a neighborhood or city via Google Text Search."""
    hits = search(area, None, None)
    if not hits:
        return None
    loc = hits[0].get("location") or {}
    return (loc.get("latitude"), loc.get("longitude")) if loc else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--name", default="")
    ap.add_argument("--email", default="")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--file")
    ap.add_argument("--home", help="LAT,LNG (otherwise taken from what they wrote)")
    ap.add_argument("--db")
    args = ap.parse_args()

    load_env()
    for k in ("ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY"):
        if not os.environ.get(k):
            sys.exit(f"{k} not set (put it in .env)")
    text = args.text if args.text else open(args.file, encoding="utf-8").read()

    con = connect(args.db)
    ensure_schema(con)
    taste = parse_taste(text)

    home, label = None, taste.get("home_area") or ""
    if args.home:
        home = tuple(float(x) for x in args.home.split(","))
    elif label:
        home = geocode(label)
    existing = con.execute("SELECT 1 FROM users WHERE user_id=?", (args.user,)).fetchone()
    if existing:
        if home:
            con.execute("UPDATE users SET home_lat=?, home_lng=?, home_label=? WHERE user_id=?",
                        (home[0], home[1], label, args.user))
    else:
        con.execute("INSERT INTO users (user_id, display_name, home_lat, home_lng, home_label, email) "
                    "VALUES (?,?,?,?,?,?)", (args.user, args.name, home[0] if home else None,
                                             home[1] if home else None, label, args.email))

    # favorite places -> places table as favorites, matched near home
    matched, unmatched = [], []
    for pl in taste["places"]:
        # a place named with its own area ("Di Fara in Brooklyn") is searched there, not near home
        near = None if pl["area"] else home
        query = f"{pl['name']} {pl['area'] or label}".strip()
        hits = search(query, *(near if near else (None, None)))
        if not hits:
            unmatched.append(pl["name"])
            continue
        g, sim, dist, conf = pick(pl["name"], near, hits)
        if conf == "weak":
            unmatched.append(pl["name"])
            continue
        types = g.get("types", [])
        loc = g["location"]
        con.execute(
            """INSERT OR REPLACE INTO places (user_id, list_name, place_id, title, note, lat, lng, categories,
               google_place_id, google_name, address, name_similarity, match_distance_m, match_confidence,
               is_food, enrich_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (args.user, "favorites", "onboard:" + g["id"], pl["name"], "", loc["latitude"], loc["longitude"],
             ",".join(types), g["id"], g.get("displayName", {}).get("text", ""), g.get("formattedAddress"),
             round(sim, 3), round(dist) if dist is not None else None, conf, 1 if is_food_types(types) else 0, 2))
        matched.append(f"{g.get('displayName', {}).get('text', '')} ({g.get('formattedAddress', '')})")

    rows = [("cuisine", c) for c in taste["cuisines"]] + [("dish", d) for d in taste["dishes"]]
    rows += [("format", f) for f in taste["formats"]]
    rows += [(f"source_{s['type']}", s["name"]) for s in taste["sources"]]
    d = taste["dislikes"]
    rows += [("dislike_cuisine", x) for x in d.get("cuisines", [])] + [("dislike_dish", x) for x in d.get("dishes", [])]
    rows += [("dislike_format", x) for x in d.get("formats", [])] + [("dislike_other", x) for x in d.get("other", [])]
    con.executemany("INSERT OR REPLACE INTO user_prefs (user_id, kind, value, raw) VALUES (?,?,?,?)",
                    [(args.user, k, v.strip().lower() if not k.startswith("source_") else v.strip(), text)
                     for k, v in rows if v and v.strip()])
    con.commit()
    con.close()

    print(f"User {args.user}: home {label or 'not given'}" + (f" ({home[0]:.3f}, {home[1]:.3f})" if home else ""))
    print(f"Favorite places matched: {len(matched)}")
    for m in matched:
        print(f"  {m}")
    if unmatched:
        print(f"Could not match: {', '.join(unmatched)}")
    print("Stated:", json.dumps({k: v for k, v in taste.items() if k not in ("places", "home_area")},
                                ensure_ascii=False))
    print(f"\nnext: python profile.py --user {args.user} && python digest.py --user {args.user}")


if __name__ == "__main__":
    main()
