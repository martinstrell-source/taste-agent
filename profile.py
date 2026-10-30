#!/usr/bin/env python3
"""Build a taste profile from saved places (v2).

Uses the Claude extraction (dishes, cuisine, sources, sentiment) and Google's place
categories in place of v1's title keyword matching.

Rules:
- Built per user. Nothing in here is specific to one person.
- Food and drink places only (is_food = 1), from anywhere. Taste is portable.
- Favorites and places the user said they loved count double; want-to-go counts once.
- Places the user said "meh" or "no" to are recorded so the matcher can avoid look-alikes.
- Google categories count only for good/ok matches. Weak matches still count through
  their notes, since the note is about the place the user saved, not what Google returned.
- Saving the same place twice counts once.

Usage:
    python profile.py --user martin
    python profile.py --user martin --out data/profiles/martin.json   # also save a copy as a file
Writes the profile to the user_profiles table in Supabase and prints a summary.
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from common import connect, ensure_schema, get_user, json_param, lat_sql, lng_sql

ROOT = Path(__file__).parent
PROFILE_DIR = ROOT / "data" / "profiles"
# how much each kind of evidence counts
WEIGHT = {"favorites": 2.0, "want_to_go": 1.0, "other_list": 1.0, "love": 2.0, "want": 1.0}
# something the user stated directly at signup ("I love Burmese food") counts like this many saved places
STATED = {"cuisine": 5.0, "format": 5.0, "dish": 3.0, "source": 5.0}
DISLIKE_KEY = {"dislike_cuisine": "cuisines", "dislike_dish": "dishes", "dislike_format": "formats",
               "dislike_other": "other"}

# Google type -> format (what kind of outing it is)
FORMAT_OF = {
    "coffee_shop": "coffee", "coffee_roastery": "coffee", "coffee_stand": "coffee", "cafe": "cafe",
    "tea_house": "tea", "tea_store": "tea", "bubble_tea_shop": "tea",
    "bakery": "bakery", "pastry_shop": "bakery", "cake_shop": "bakery", "bagel_shop": "bakery",
    "donut_shop": "bakery",
    "ice_cream_shop": "dessert", "dessert_shop": "dessert", "dessert_restaurant": "dessert",
    "confectionery": "dessert", "chocolate_shop": "dessert", "candy_store": "dessert",
    "bar": "bar", "wine_bar": "bar", "cocktail_bar": "bar", "pub": "bar", "brewery": "bar",
    "brewpub": "bar", "winery": "bar",
    "market": "market", "grocery_store": "market", "asian_grocery_store": "market",
    "deli": "market", "food_court": "market",
    "restaurant": "restaurant", "sandwich_shop": "restaurant", "noodle_shop": "restaurant",
    "meal_takeaway": "restaurant",
}
# extraction kind -> format
KIND_FORMAT = {"restaurant": "restaurant", "bakery": "bakery", "cafe": "cafe", "dessert": "dessert",
               "bar": "bar", "market": "market", "food_truck": "restaurant"}

# *_restaurant types that describe style or meal, not cuisine
NOT_CUISINE = {"european", "asian", "american", "breakfast", "brunch", "family", "fast_food",
               "fine_dining", "fusion", "asian_fusion", "dessert", "vegetarian", "vegan", "halal",
               "lunch", "dinner", "buffet", "seafood_casual"}
# normalize cuisine labels from both sources
CUISINE_ALIAS = {"chinese_noodle": "chinese", "sushi": "japanese", "ramen": "japanese",
                 "south indian": "indian", "south_indian": "indian", "hamburger": "burgers",
                 "pizza": "pizza", "barbecue": "bbq", "middle eastern": "middle_eastern",
                 "uighur": "uyghur", "central asian": "uyghur/central asian",
                 "uyghur": "uyghur/central asian", "uzbek": "uyghur/central asian"}


# Google files many regional cuisines under a generic type (a Uyghur place comes back as
# "chinese" or "halal", a Oaxacan one as "mexican"), so the place name is a useful extra signal.
# General list, not tuned to any one user.
TITLE_CUISINE = {
    "uyghur/central_asian": ["uyghur", "uighur", "uzbek", "lagman", "laghman", "silk road", "xinjiang",
                             "kashgar", "urumqi", "kazakh", "kyrgyz", "tajik", "afghan"],
    "sichuan": ["sichuan", "szechuan", "chongqing", "mala "],
    "hunan": ["hunan", "xiang "],
    "cantonese": ["cantonese", "dim sum", "hong kong", "hk cafe", "cha chaan"],
    "taiwanese": ["taiwanese", "taiwan"],
    "dongbei": ["dongbei", "northeast china", "harbin"],
    "shanghainese": ["shanghai", "xiao long", "xlb"],
    "lanzhou_noodles": ["lanzhou", "hand pulled", "hand-pulled", "biang"],
    "burmese": ["burmese", "burma", "myanmar"],
    "filipino": ["filipino", "lumpia", "adobo", "sisig"],
    "oaxacan": ["oaxaca", "tlayuda", "mole "],
    "yucatecan": ["yucatan", "cochinita"],
    "peruvian": ["peruvian", "ceviche", "pollo a la brasa"],
    "salvadoran": ["salvadoran", "pupusa"],
    "ethiopian": ["ethiopian", "eritrean", "injera", "habesha"],
    "yemeni": ["yemeni", "yemen", "mandi"],
    "persian": ["persian", "iranian", "tehran"],
    "georgian": ["georgian", "khachapuri"],
    "sri_lankan": ["sri lanka", "lankan"],
    "south_indian": ["dosa", "idli", "chettinad", "udupi", "kerala", "madras"],
    "hawaiian": ["hawaiian", "poke", "plate lunch"],
}


def norm_cuisine(c):
    c = (c or "").strip().lower().replace("-", " ")
    c = CUISINE_ALIAS.get(c, c)
    return c.replace(" ", "_") if c else ""


def region(lat, lng):
    if lat is None:
        return "unknown"
    if 36.9 <= lat <= 38.6 and -123.2 <= lng <= -121.4:
        return "Bay Area"
    if 32 <= lat <= 42.1 and -124.5 <= lng <= -114:
        return "rest of California"
    if 24 <= lat <= 50 and -125 <= lng <= -66:
        return "rest of US"
    if 30 <= lat <= 46 and 129 <= lng <= 146:
        return "Japan"
    if 18 <= lat <= 54 and 73 <= lng <= 135:
        return "China / HK / Taiwan"
    if 34 <= lat <= 71 and -11 <= lng <= 40:
        return "Europe"
    return "elsewhere"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--out", help="also write the profile to this JSON file")
    args = ap.parse_args()

    con = connect()
    ensure_schema(con)
    uid = get_user(con, args.user)["uid"]
    rows = con.execute(f"""
        SELECT p.place_key, p.title, p.google_place_id, array_to_string(p.categories, ','), p.match_confidence,
               {lat_sql('p.location')}, {lng_sql('p.location')}, e.dishes::text, e.cuisine, e.sources::text,
               e.kind, e.sentiment, e.reason, p.list_name
        FROM places p LEFT JOIN note_extractions e ON e.user_id = p.user_id AND e.place_key = p.place_key
        WHERE p.user_id = %s AND p.is_food AND p.removed_at IS NULL
          AND coalesce(p.hidden_reason, '') <> 'didnt_like'   -- "Closed" places still count
        ORDER BY CASE p.list_name WHEN 'favorites' THEN 0 WHEN 'want_to_go' THEN 1 ELSE 2 END, p.id
    """, (uid,)).fetchall()
    # places the user reacted to (usually earlier picks): use the feed candidate's data
    fb = con.execute(f"""
        SELECT f.google_place_id, f.name, f.reaction, c.categories, c.cuisine, c.dishes, c.lat, c.lng
        FROM feedback f
        LEFT JOIN (SELECT google_place_id, max(array_to_string(categories, ',')) categories,
                          max(cuisine) cuisine, max(dishes::text) dishes,
                          max({lat_sql('location')}) lat, max({lng_sql('location')}) lng
                   FROM candidates GROUP BY google_place_id) c USING (google_place_id)
        WHERE f.user_id = %s
        ORDER BY f.created_at
    """, (uid,)).fetchall()
    for gid, name, reaction, cats, cuisine, dishes_j, lat, lng in fb:
        if reaction in ("love", "want"):
            rows.append((None, name, gid, cats, "good", lat, lng, dishes_j, cuisine, None, None, None, None,
                         reaction))
    avoid = [{"google_place_id": gid, "name": name, "reaction": reaction, "categories": cats, "cuisine": cuisine}
             for gid, name, reaction, cats, cuisine, *_ in fb if reaction in ("meh", "no")]
    prefs = con.execute("SELECT kind, value FROM user_prefs WHERE user_id=%s ORDER BY created_at, kind, value",
                        (uid,)).fetchall()

    seen = set()
    formats, cuisines, dishes = Counter(), Counter(), Counter()
    sources, source_types = Counter(), Counter()
    source_type_of, source_examples = {}, defaultdict(list)
    regions, sentiments = Counter(), Counter()
    flagged = []
    n = n_noted = 0

    for (pid, title, gid, cats, conf, lat, lng, dishes_j, cuisine, sources_j,
         kind, sentiment, reason, list_name) in rows:
        key = gid or pid
        if key in seen:
            continue
        seen.add(key)
        w = WEIGHT.get(list_name, WEIGHT["other_list"])
        n += w
        regions[region(lat, lng)] += 1
        types = (cats or "").split(",") if conf in ("good", "ok") else []

        place_formats = {FORMAT_OF[t] for t in types if t in FORMAT_OF}
        if kind in KIND_FORMAT:
            place_formats.add(KIND_FORMAT[kind])
        if "cafe" in place_formats and "coffee" in place_formats:
            place_formats.discard("cafe")
        for f in place_formats:
            formats[f] += w

        place_cuisines = {norm_cuisine(t[: -len("_restaurant")]) for t in types
                          if t.endswith("_restaurant") and t[: -len("_restaurant")] not in NOT_CUISINE}
        if cuisine:
            place_cuisines.add(norm_cuisine(cuisine))
        tl = (title or "").lower()
        for label, words in TITLE_CUISINE.items():
            if any(w in tl for w in words):
                place_cuisines.add(label)
        place_cuisines.discard("")
        for c in place_cuisines:
            cuisines[c] += w

        for d in json.loads(dishes_j or "[]"):
            if d.strip():
                dishes[d.strip().lower()] += w
        if sources_j is not None:
            n_noted += 1
            for s in json.loads(sources_j or "[]"):
                sources[s["name"]] += 1
                source_types[s["type"]] += 1
                source_type_of[s["name"]] = s["type"]
                if len(source_examples[s["name"]]) < 3:
                    source_examples[s["name"]].append(title)
            if sentiment:
                sentiments[sentiment] += 1
            if sentiment in ("negative", "near_miss"):
                flagged.append({"title": title, "sentiment": sentiment, "reason": reason})

    # what the user ordered on visits they liked (Log a visit): those dishes count toward taste
    for items_j, reaction in con.execute(
            "SELECT items_ordered::text, reaction FROM visits WHERE user_id=%s AND items_ordered IS NOT NULL "
            "AND reaction IN ('love', 'fine')", (uid,)).fetchall():
        w = WEIGHT["love"] if reaction == "love" else WEIGHT["want"]
        for it in json.loads(items_j or "[]"):
            name = (it.get("name") or it.get("item") or "").strip().lower() if isinstance(it, dict) else ""
            if name:
                dishes[name] += w

    # stated preferences from signup
    dislikes = {"cuisines": [], "dishes": [], "formats": [], "other": []}
    for kind, value in prefs:
        if kind == "cuisine":
            cuisines[norm_cuisine(value)] += STATED["cuisine"]
            n += STATED["cuisine"]
        elif kind == "format":
            formats[value] += STATED["format"]
        elif kind == "dish":
            dishes[value] += STATED["dish"]
        elif kind.startswith("source_"):
            sources[value] += STATED["source"]
            source_type_of[value] = kind[len("source_"):]
            source_types[kind[len("source_"):]] += 1
        elif kind in DISLIKE_KEY:
            dislikes[DISLIKE_KEY[kind]].append(norm_cuisine(value) if kind == "dislike_cuisine" else value)

    # edits from the app's "Your taste" screen: things the user said aren't them come out
    hidden_cuisines = {norm_cuisine(v) for k, v in prefs if k == "not_cuisine"}
    hidden_dishes = {v.strip().lower() for k, v in prefs if k == "not_dish"}
    for c in hidden_cuisines:
        cuisines.pop(c, None)
    for d in hidden_dishes:
        dishes.pop(d, None)

    n = n or 1  # empty profile (nothing enriched yet) still writes a valid file
    top_source = max(sources.values()) if sources else 1
    profile = {
        "version": 3,
        "user_id": args.user,
        "n_food_places": round(n, 1),
        "n_with_notes": n_noted,
        "regions": dict(regions.most_common()),
        "formats": {k: {"count": v, "share": round(v / n, 3)} for k, v in formats.most_common()},
        "cuisines": {k: {"count": v, "share": round(v / n, 3)} for k, v in cuisines.most_common()},
        "dishes": dict(dishes.most_common()),
        "sources": [
            {"name": s, "type": source_type_of[s], "count": c,
             "trust": round(c / top_source, 3), "examples": source_examples[s]}
            for s, c in sources.most_common()
        ],
        "source_types": dict(source_types.most_common()),
        "sentiments": dict(sentiments),
        "negative_or_near_miss": flagged,
        "avoid": avoid,
        "dislikes": dislikes,
        "stated_cuisines": sorted({norm_cuisine(v) for k, v in prefs if k == "cuisine"}),
        "hidden": {"cuisines": sorted(hidden_cuisines), "dishes": sorted(hidden_dishes)},
        "n_stated": len(prefs),
    }
    con.execute("""INSERT INTO user_profiles (user_id, profile, updated_at) VALUES (%s, %s, now())
                   ON CONFLICT (user_id) DO UPDATE SET profile = excluded.profile, updated_at = now()""",
                (uid, json_param(profile)))
    con.commit()
    con.close()
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(profile, indent=2, ensure_ascii=False))

    print(f"Food and drink places (weighted; favorites and loved places count double): {n:.0f} "
          f"({n_noted} with notes)\n")
    print("Where:")
    for k, v in regions.most_common():
        print(f"  {v:4d}  {k}")
    print("\nWhat kind of place:")
    for k, v in formats.most_common():
        print(f"  {v:6.0f}  {k:12s} {v / n:5.0%}")
    print("\nTop cuisines:")
    for k, v in cuisines.most_common(15):
        print(f"  {v:6.0f}  {k}")
    print("\nDishes named more than once:")
    rep = [(d, c) for d, c in dishes.most_common() if c > 1]
    print("  " + (", ".join(f"{d} ({c})" for d, c in rep) or "none"))
    print(f"  plus {sum(1 for c in dishes.values() if c <= 1)} named once")
    print("\nMost-used sources (trust = share of top source):")
    for s in profile["sources"][:12]:
        print(f"  {s['count']:4.0f}  {s['name']:16s} {s['type']:13s} trust {s['trust']:.2f}")
    print("\nSource types:", dict(source_types.most_common()))
    if flagged:
        print("\nNegative / near miss:", "; ".join(f["title"] for f in flagged))
    if avoid:
        print("\nSaid meh/no to:", ", ".join(a["name"] for a in avoid))
    if any(dislikes.values()):
        print("Dislikes:", {k: v for k, v in dislikes.items() if v})
    print("\nsaved to Supabase (user_profiles)" + (f" and {args.out}" if args.out else ""))


if __name__ == "__main__":
    main()
