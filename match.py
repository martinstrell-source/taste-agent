#!/usr/bin/env python3
"""Score candidate places from the feeds against one user's taste profile.

Score (0-1) = weighted sum of:
  cuisine   0.35  how much more often the user saves this cuisine than a typical diner would
  format    0.20  same idea for kind of place (coffee, bakery, bar, ...)
  dish      0.15  overlap between dishes the article highlights and dishes the user has saved
  source    0.10  how often the user saves from this source
  mention   0.10  opening/review > list entry > news
  distance  0.10  closer to the user's home scores a bit higher
Places mentioned by more than one article get a small bonus. If the article panned the place
(tone), the score is cut. Places already on the user's lists or already reacted to are not picks.

Typical-diner shares (BASE_*) are rough estimates for the Bay Area, not measured data.
Tune them as feedback comes in.

Backtest: candidates already on the user's lists, and ones they said they loved, are ranked
along with the rest. A useful matcher ranks them high. (Mild leakage: those places also feed
the profile.)

  python match.py --user martin                 # rank, backtest, write data/picks/<user>.json
  python match.py --user martin --explain 10    # also have Claude write a one-line reason for the top 10

Google rating and review count are fetched for the top picks only (--ratings, default 15) and
cached for 30 days. They are Enterprise-tier fields: 1,000 free a month, so ~15 a week is free.
"""
import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path

from common import connect, ensure_schema, get_user, lat_sql, lng_sql, norm
from profile import FORMAT_OF, NOT_CUISINE, TITLE_CUISINE, norm_cuisine
from s2decode import haversine_m

ROOT = Path(__file__).parent
PICKS_DIR = ROOT / "data" / "picks"
TONE = {"positive": 1.0, "neutral": 0.9, "mixed": 0.6, "negative": 0.0}

WEIGHTS = {"cuisine": 0.35, "format": 0.20, "dish": 0.15, "source": 0.10, "mention": 0.10, "distance": 0.10}

# Rough share of Bay Area food places by cuisine / format (estimates; unknown cuisines default 0.02)
BASE_CUISINE = {
    "american": 0.15, "chinese": 0.10, "mexican": 0.10, "italian": 0.07, "japanese": 0.07,
    "pizza": 0.06, "burgers": 0.04, "thai": 0.04, "indian": 0.04, "vietnamese": 0.04,
    "korean": 0.03, "mediterranean": 0.03, "seafood": 0.03, "french": 0.02, "bbq": 0.02,
    "middle_eastern": 0.02, "californian": 0.03, "uyghur/central_asian": 0.002,
}
BASE_FORMAT = {"restaurant": 0.60, "bar": 0.12, "coffee": 0.10, "cafe": 0.06, "bakery": 0.05,
               "dessert": 0.05, "market": 0.04, "tea": 0.02}
MENTION = {"opening": 1.0, "review": 1.0, "list_entry": 0.8, "news": 0.6,
           "discovery": 0.75}  # discovery = found by discover.py's Google search for a cuisine, no article
# feed name -> the name people use for it in their notes
SOURCE_ALIAS = {"Eater SF": "Eater", "SF Standard": "SF Standard", "SFist": "SFist",
                "Tablehopper": "Tablehopper"}

# Map free-form cuisine labels ("japanese_french", "south_asian_(tamil)") onto known cuisines
CUISINE_WORDS = {
    "tamil": "indian", "south asian": "indian", "south indian": "indian", "indian": "indian",
    "eritrean": "ethiopian", "ethiopian": "ethiopian", "sicilian": "italian", "neapolitan": "pizza",
    "middle eastern": "middle_eastern", "uyghur": "uyghur/central_asian", "uzbek": "uyghur/central_asian",
    "central asian": "uyghur/central_asian", "hamburger": "burgers", "burger": "burgers",
    "barbecue": "bbq", "sushi": "japanese", "ramen": "japanese", "dim sum": "chinese",
    "cantonese": "chinese", "sichuan": "chinese", "taiwanese": "taiwanese", "persian": "persian",
}


def canon_cuisines(label, known):
    """'japanese_french' -> {'japanese', 'french'}; unknown labels pass through cleaned."""
    text = " " + re.sub(r"[^a-z]+", " ", (label or "").lower()) + " "
    found = {v for k, v in CUISINE_WORDS.items() if f" {k} " in text}
    found |= {k for k in known if " " + k.replace("_", " ") + " " in text}
    if not found and text.strip():
        found.add(norm_cuisine(text.strip()))
    return found


STOP = {"the", "a", "an", "of", "and", "with", "in", "on", "style", "house", "special"}


def tokens(s):
    return {w for w in re.findall(r"[a-z]+", s.lower()) if w not in STOP and len(w) > 2}


def lift_score(share, base, max_share, cap=8.0):
    """0..1. Half distinctiveness (how much more often than a typical diner, 1 at `cap` times),
    half plain volume (share relative to the user's most-saved one)."""
    if share <= 0:
        return 0.0
    lift = share / base
    distinct = max(0.0, min(1.0, math.log(lift) / math.log(cap))) if lift > 1 else 0.0
    return 0.5 * distinct + 0.5 * min(1.0, share / max_share)


def place_features(cats, cuisine, name, known=()):
    types = (cats or "").split(",") if cats else []
    formats = {FORMAT_OF[t] for t in types if t in FORMAT_OF}
    if "cafe" in formats and "coffee" in formats:
        formats.discard("cafe")
    cuisines = set()
    for t in types:
        if t.endswith("_restaurant") and t[: -len("_restaurant")] not in NOT_CUISINE:
            cuisines |= canon_cuisines(t[: -len("_restaurant")], known)
    if cuisine:
        cuisines |= canon_cuisines(cuisine, known)
    tl = (name or "").lower()
    for label, words in TITLE_CUISINE.items():
        if any(w in tl for w in words):
            cuisines.add(label)
    cuisines.discard("")
    return formats, cuisines


# future moves only ("relocated in 2022" is history, not news)
MOVING = re.compile(r"\b(relocating|will relocate|to relocate|is moving|will move|moving to)\b", re.I)


def load_profile(con, user, path=None):
    """The user's taste profile from Supabase (written by profile.py), or from a JSON file if a path is given."""
    if path:
        return json.loads(Path(path).read_text())
    row = con.execute("SELECT profile FROM user_profiles WHERE user_id=%s", (user["uid"],)).fetchone()
    if not row:
        raise SystemExit(f"No taste profile for {user['user_id']} yet. Run: python profile.py --user {user['user_id']}")
    return row[0]


PRICE = {"PRICE_LEVEL_INEXPENSIVE": "$", "PRICE_LEVEL_MODERATE": "$$", "PRICE_LEVEL_EXPENSIVE": "$$$",
         "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$", "PRICE_LEVEL_FREE": "free"}


def fetch_rating(gid):
    import os
    import urllib.request
    from common import SSL_CTX
    req = urllib.request.Request(
        f"https://places.googleapis.com/v1/places/{gid}",
        headers={"X-Goog-Api-Key": os.environ["GOOGLE_MAPS_API_KEY"],
                 "X-Goog-FieldMask": "rating,userRatingCount,priceLevel"})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        d = json.load(resp)
    return d.get("rating"), d.get("userRatingCount"), d.get("priceLevel")


def add_ratings(con, picks):
    """Attach Google rating/review count/price to picks, using a 30-day cache."""
    from common import load_env
    load_env()
    calls = 0
    for p in picks:
        row = con.execute("SELECT rating, user_rating_count, price_level FROM place_ratings "
                          "WHERE google_place_id=%s AND fetched_at > now() - interval '30 days'",
                          (p["google_place_id"],)).fetchone()
        if row is None:
            try:
                row = fetch_rating(p["google_place_id"])
                calls += 1
                con.execute("""INSERT INTO place_ratings (google_place_id, rating, user_rating_count, price_level,
                               fetched_at) VALUES (%s,%s,%s,%s,now())
                               ON CONFLICT (google_place_id) DO UPDATE SET rating=excluded.rating,
                               user_rating_count=excluded.user_rating_count, price_level=excluded.price_level,
                               fetched_at=excluded.fetched_at""", (p["google_place_id"], *row))
                con.commit()
            except Exception as e:  # noqa: BLE001 - a missing rating should not stop the run
                print(f"  rating lookup failed for {p['name']}: {e}")
                continue
        p["rating"], p["review_count"], p["price"] = row[0], row[1], PRICE.get(row[2] or "", "")
    return calls


def explain(picks, prof, model="claude-sonnet-5-5"):
    """Claude writes one plain line per pick on why this user might like it."""
    import anthropic
    from common import load_env
    load_env()
    client = anthropic.Anthropic()
    top_cuisines = ", ".join(list(prof["cuisines"])[:12])
    top_sources = ", ".join(s["name"] for s in prof["sources"][:8])
    top_formats = ", ".join(list(prof["formats"])[:5])
    dishes = ", ".join(list(prof["dishes"])[:25])
    for p in picks:
        takes = "; ".join(f'{m["source"]} ({m["tone"]}): {m["what_it_says"]}' for m in p.get("mentions", []))
        prompt = (
            "Write one plain sentence (under 25 words) telling the user why they might like this place. "
            "Use only the facts given. Do not invent dishes or claims. No hype words, no exclamation marks, "
            "no em dashes, no 'you'll love'.\n\n"
            f"Cuisines the user saves most: {top_cuisines}.\nKinds of place they save most: {top_formats}.\n"
            f"Dishes they have saved: {dishes}.\nSources they save from most: {top_sources}.\n\n"
            f"Place: {p['name']}, {p['address']}\n"
            f"Cuisine/type: {', '.join(p['cuisines'] + p['formats'])}\n"
            f"What articles say: {takes}\n"
            f"Dishes mentioned: {', '.join(p['dishes']) or 'none'}"
        )
        r = client.messages.create(model=model, max_tokens=200, messages=[{"role": "user", "content": prompt}])
        p["why"] = "".join(b.text for b in r.content if b.type == "text").strip()


def neighborhood(address):
    """'4033 Judah St, San Francisco, CA 94122, USA' -> 'San Francisco'."""
    parts = [x.strip() for x in (address or "").split(",")]
    return parts[1] if len(parts) >= 3 else (parts[0] if parts else "")


MIN_POOL = 300  # places in the shared pool before its measured base rates are trusted


def load_base(con):
    """How common each cuisine is among Bay Area food places (the cuisine_base view), as a share of
    cuisine-tagged places to match how this file measures the user; the fixed BASE_CUISINE guesses
    fill gaps and stand in until the pool is big enough."""
    base = dict(BASE_CUISINE)
    try:
        rows = con.execute("SELECT cuisine, places, pool_size FROM cuisine_base").fetchall()
    except Exception:  # noqa: BLE001  (view not created yet)
        con.rollback()
        return base
    if rows and rows[0][2] >= MIN_POOL:
        tagged = sum(r[1] for r in rows) or 1
        base.update({c: n / tagged for c, n, _ in rows})
    return base


def rank_places(con, user, prof):
    """Score every usable candidate for this user. Returns a list sorted best first."""
    user_id, uid = user["user_id"], user["uid"]
    home = user["home"]
    # shares among tagged places, so they compare with the typical-diner estimates
    c_total = sum(v["count"] for v in prof["cuisines"].values()) or 1
    cuisine_share = {k: v["count"] / c_total for k, v in prof["cuisines"].items()}
    f_total = sum(v["count"] for v in prof["formats"].values()) or 1
    format_share = {k: v["count"] / f_total for k, v in prof["formats"].items()}
    if not cuisine_share and not format_share:
        raise SystemExit(f"Profile for {user_id} is empty. Run enrich.py and profile.py for this user first.")
    c_max, f_max = max(cuisine_share.values(), default=1.0), max(format_share.values(), default=1.0)
    base_cuisine = load_base(con)
    known = set(cuisine_share) | set(base_cuisine)
    my_dishes = list(prof["dishes"].keys())
    my_dish_tokens = [tokens(d) for d in my_dishes]
    trust = {s["name"]: s["trust"] for s in prof["sources"]}
    dislikes = prof.get("dislikes") or {}
    dis_cuisines = set(dislikes.get("cuisines", []))
    # cuisines the user clearly likes: stated at signup, or among their top saved ones
    liked_cuisines = set(prof.get("stated_cuisines", [])) | set(list(prof["cuisines"])[:8])
    liked_cuisines -= dis_cuisines
    dis_formats = set(dislikes.get("formats", []))
    dis_dish_tokens = [tokens(d) for d in dislikes.get("dishes", [])]

    rows = con.execute(f"""
        SELECT google_place_id, google_name, address, {lat_sql('location')}, {lng_sql('location')},
               array_to_string(categories, ','), cuisine, dishes::text,
               mention_type, source, what_it_says, item_title, item_link, maps_uri, coalesce(tone, 'neutral'),
               location_hint
        FROM candidates
        WHERE is_food AND in_bay_area AND google_place_id IS NOT NULL
          AND coalesce(business_status, 'OPERATIONAL') = 'OPERATIONAL'
          AND mention_type NOT IN ('closing', 'passing') AND match_confidence <> 'weak'
        ORDER BY id
    """).fetchall()
    # what this user already knows: their saved places (by Google id, or same name within 300 m)
    saved_ids = {r[0] for r in con.execute(
        "SELECT google_place_id FROM places WHERE user_id=%s AND google_place_id IS NOT NULL", (uid,))}
    saved_named = [(norm(t), norm(g or ""), la, ln) for t, g, la, ln in con.execute(
        f"SELECT title, google_name, {lat_sql('location')}, {lng_sql('location')} FROM places "
        "WHERE user_id=%s AND location IS NOT NULL", (uid,))]
    reacted = dict(con.execute("SELECT google_place_id, reaction FROM feedback WHERE user_id=%s", (uid,)).fetchall())

    def known_status(gid, name, lat, lng):
        if gid in reacted:
            return reacted[gid]
        if gid in saved_ids:
            return "saved"
        n = norm(name)
        for t, g, la, ln in saved_named:
            if (n == t or n == g) and haversine_m(lat, lng, la, ln) < 300:
                return "saved"
        return None

    # Google rating for places found by search alone (no article to vouch for them)
    ratings = {g: (r, n) for g, r, n in con.execute(
        "SELECT google_place_id, rating, user_rating_count FROM place_ratings")}

    by_place = defaultdict(list)
    for r in rows:
        by_place[r[0]].append(r)

    ranked = []
    for gid, mentions in by_place.items():
        best = None
        for (_, gname, addr, lat, lng, cats, cuisine, dishes_j, mtype, source, says, ititle,
             ilink, maps_uri, tone, hint) in mentions:
            formats, cuisines = place_features(cats, cuisine, gname, known)
            c_scores = {c: lift_score(cuisine_share.get(c, 0), max(0.002, base_cuisine.get(c, 0.02)), c_max) for c in cuisines}
            f_scores = {f: lift_score(format_share.get(f, 0), BASE_FORMAT.get(f, 0.05), f_max) for f in formats}
            dishes = json.loads(dishes_j or "[]")
            d_best, d_match = 0.0, None
            for d in dishes:
                dt = tokens(d)
                for mine, mt in zip(my_dishes, my_dish_tokens):
                    if dt and mt:
                        j = len(dt & mt) / len(dt | mt)
                        if j >= 0.5 and j > d_best:
                            d_best, d_match = j, (d, mine)
            src = SOURCE_ALIAS.get(source, source)
            parts = {
                "cuisine": max(c_scores.values(), default=0.0),
                "format": max(f_scores.values(), default=0.0),
                "dish": d_best,
                "source": 0.3 + 0.7 * trust.get(src, 0.0),
                "mention": MENTION.get(mtype, 0.5),
                "distance": 1 / (1 + haversine_m(lat, lng, *home) / 1000 / 15) if home else 0.5,
            }
            score = sum(WEIGHTS[k] * v for k, v in parts.items()) * TONE.get(tone, 0.9)
            if mtype == "discovery":
                rating, n_rev = ratings.get(gid, (None, None))
                if rating and (n_rev or 0) >= 20:  # 4.2 stars -> x0.85, 5.0 -> x1.0
                    score *= 0.85 + 0.15 * max(0.0, min(1.0, (rating - 4.2) / 0.8))
                else:
                    score *= 0.9  # too new to judge
            # stated dislikes: a place that is mainly something the user avoids drops a lot
            types_set = set((cats or "").split(","))
            if cuisines & dis_cuisines and not (cuisines & liked_cuisines):
                score *= 0.3
            if (formats & dis_formats) or ("fine_dining" in dis_formats and "fine_dining_restaurant" in types_set):
                score *= 0.5
            if any(dt and dt <= tokens(" ".join(dishes)) for dt in dis_dish_tokens):
                score *= 0.7
            if best is None or score > best["score"]:
                best = {
                    "google_place_id": gid, "name": gname, "address": addr, "maps_uri": maps_uri,
                    "score": score, "parts": {k: round(v, 2) for k, v in parts.items()},
                    "cuisines": sorted(cuisines), "formats": sorted(formats), "dishes": dishes,
                    "dish_match": d_match, "mention_type": mtype, "source": source,
                    "what_it_says": says, "article": ititle, "link": ilink, "tone": tone, "area": hint,
                    "known": known_status(gid, gname, lat, lng),
                    "top_cuisine": max(c_scores, key=c_scores.get) if c_scores else None,
                }
        best["mentions"] = [
            {"source": m[9], "article": m[11], "link": m[12], "what_it_says": m[10], "tone": m[14],
             "mention_type": m[8]} for m in mentions]
        best["moving"] = any(MOVING.search(m[10] or "") for m in mentions)
        n_sources = len({m[9] for m in mentions})
        best["n_articles"] = len(mentions)
        best["score"] = round(min(1.0, best["score"] + 0.05 * (n_sources - 1)), 3)
        ranked.append(best)

    ranked.sort(key=lambda x: -x["score"])
    for i, p in enumerate(ranked, 1):
        p["rank"] = i
    return ranked


def short_reason(p):
    """A short, plain reason for the app's Best match sort, built from the score's parts (no API call)."""
    parts, bits = p["parts"], []
    top = (p.get("top_cuisine") or "").replace("_", " ")
    if top and parts.get("cuisine", 0) >= 0.4:
        bits.append(f"{top.title()}, one of your top cuisines")
    elif top and parts.get("cuisine", 0) >= 0.2:
        bits.append(f"{top.title()}, which you save often")
    if p.get("dish_match"):
        bits.append(f"has {p['dish_match'][0]}, like dishes you've noted")
    if parts.get("source", 0) >= 0.6:
        bits.append(f"from {p['source']}, a source you trust")
    if parts.get("distance", 0) >= 0.75:
        bits.append("close to home")
    if p.get("mention_type") == "opening":
        bits.append("newly opened")
    text = "; ".join(bits[:2])
    return (text[0].upper() + text[1:]) if text else None


def save_scores(con, uid, picks):
    """Store each pick's score and reason for this user (the app's Best match sort reads them)."""
    # replace only the weekly run's own scores; Discover here keeps its scores for places outside the Bay Area
    con.execute("DELETE FROM pick_scores WHERE user_id=%s AND source = 'match'", (uid,))
    with con.cursor() as cur:
        cur.executemany("""INSERT INTO pick_scores (user_id, google_place_id, score, reason, source)
                           VALUES (%s,%s,%s,%s,'match')
                           ON CONFLICT (user_id, google_place_id) DO UPDATE SET score=excluded.score,
                             reason=excluded.reason, source='match', updated_at=now()""",
                        [(uid, p["google_place_id"], p["score"], short_reason(p)) for p in picks])
    con.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--profile", help="read the taste profile from this JSON file instead of Supabase")
    ap.add_argument("--explain", type=int, default=0, help="Claude writes reasons for the top N")
    ap.add_argument("--show", type=int, default=15)
    ap.add_argument("--out")
    ap.add_argument("--ratings", type=int, default=15, help="fetch Google rating for the top N picks (0 = off)")
    args = ap.parse_args()

    con = connect()
    ensure_schema(con)
    user = get_user(con, args.user)
    prof = load_profile(con, user, args.profile)
    ranked = rank_places(con, user, prof)

    # backtest: places the user saved or loved should rank high; meh/no should rank low
    n = len(ranked)
    good = [p for p in ranked if p["known"] in ("saved", "love", "want")]
    bad = [p for p in ranked if p["known"] in ("meh", "no")]
    print(f"Ranked {n} places for {args.user}: {len(good)} saved/loved, {len(bad)} meh/no, "
          f"{n - len(good) - len(bad)} new\n")
    if good and n > 1:
        pct = [1 - (p["rank"] - 1) / (n - 1) for p in good]
        top_q = sum(1 for p in good if p["rank"] <= n / 4)
        print("Backtest: where do places the user saved or loved land?")
        print(f"  average percentile {sum(pct) / len(pct):.0%} (50% = no better than random)")
        print(f"  in the top quarter: {top_q} of {len(good)} (random would be about {len(good) / 4:.1f})")
        print("  ranks: " + ", ".join(f"{p['name']} #{p['rank']}" for p in good))
    if bad:
        print("  meh/no: " + ", ".join(f"{p['name']} #{p['rank']}" for p in bad))
    print()

    picks = [p for p in ranked if p["known"] is None]
    save_scores(con, user["uid"], picks)
    print(f"Saved taste scores for {len(picks)} picks (the app's Best match sort)\n")
    if args.ratings:
        calls = add_ratings(con, picks[: args.ratings])
        print(f"(Google rating lookups this run: {calls}; the rest came from the cache)\n")
    con.close()

    if args.explain:
        explain(picks[: args.explain], prof)

    print(f"Top {args.show} new picks:\n")
    for i, p in enumerate(picks[: args.show], 1):
        stars = (f"{p['rating']:.1f} stars, {p['review_count']:,} reviews" if p.get("rating") else "no Google rating")
        price = f", {p['price']}" if p.get("price") else ""
        kinds = ", ".join(c.replace("_", " ") for c in p["cuisines"] + [f for f in p["formats"] if f != "restaurant"])
        area = p["area"] if p.get("area") and len(p["area"]) <= 40 else neighborhood(p["address"])
        print(f"{i}. {p['name']}, {area} ({kinds or 'restaurant'})")
        print(f"   {stars}{price}. {p['address']}")
        print(f"   {p['source']}, \"{p['article']}\": {p['what_it_says']}")
        if p["dishes"]:
            print(f"   Dishes: {', '.join(p['dishes'][:4])}")
        if p.get("why"):
            print(f"   Why you: {p['why']}")
        print(f"   {p['link']}")
        print(f"   score {p['score']:.2f} {p['parts']}\n")

    out = Path(args.out) if args.out else PICKS_DIR / f"{args.user}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"user_id": args.user, "ranked": ranked}, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
