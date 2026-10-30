#!/usr/bin/env python3
"""Discover eval: runs Discover in a fixed set of places with your taste, then checks every suggestion.

    .venv/bin/python evals/discover_eval.py                 # quick Google search + rerank (about $1-2)
    .venv/bin/python evals/discover_eval.py --web           # also the food-press search (slower, costs more)
    .venv/bin/python evals/discover_eval.py --only baker    # one place
    .venv/bin/python evals/discover_eval.py --user martin   # whose taste to use (default martin)

It uses a separate eval account (tasteagent.martin+eval@gmail.com), never yours: each run copies your taste
into it (profile, your edits, saved places, "Not for me" answers) and clears its old suggestions, so your own
list is untouched. Discover runs through the real deployed function, the same as the app.

Checks on each suggestion: chains, not a place to eat (caterers, gas stations), closed, low rating, the same
place twice, something already saved or turned down, too far from the search, reason wording ("they",
"1 reviews", empty), and too few suggestions. The rules for chains and non-places are read from
supabase/functions/capture/discover.ts, so the eval checks what Discover is supposed to do.

Writes evals/results/<date-time>.md (with a "would you save it?" column for the top 10) and .json.
"""
import argparse
import json
import math
import os
import re
import secrets
import string
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from common import SSL_CTX, connect, get_user, load_env  # noqa: E402

EVAL_EMAIL = "tasteagent.martin+eval@gmail.com"
RADIUS_M = 6000          # the radius Discover searches
LIST_M = 6 * 1609.344    # what the list shows after Discover (6 mi)
FAR_KM = 25              # a suggestion this far from the search is a mistake
MIN_PICKS = 5

PLACES = [
    # key, name, lat, lng, why it's here
    ("alameda", "Alameda", 37.7652, -122.2416, "home"),
    ("mission", "Mission, San Francisco", 37.7599, -122.4148, "dense, food-press heavy"),
    ("fruitvale", "Fruitvale, Oakland", 37.7749, -122.2250, "Mexican-heavy: home-taste bias"),
    ("paloalto", "Palo Alto", 37.4443, -122.1598, "suburb with chains"),
    ("jericho", "Jericho, NY", 40.7920, -73.5398, "suburb: caterers showed up"),
    ("les", "Lower East Side, New York", 40.7150, -73.9843, "away, major city: institutions"),
    ("baker", "Baker, MT", 46.3667, -104.2847, "tiny town: gas stations, few reviews"),
    ("rapidcity", "Rapid City, SD", 44.0805, -103.2310, "small city: local specialties"),
]

# reasons that don't come from the rerank: plain source names and Discover's own templates
GENERIC = re.compile(r"^(well rated near you|from [^.;]+)\.?$|one of the cuisines you save most|you save a lot of it", re.I)
WORDING = [
    (re.compile(r"\b(they|their|them|themselves)\b", re.I), 'says "they"'),
    (re.compile(r"\bthe user\b", re.I), 'says "the user"'),
    (re.compile(r"\b1 reviews\b"), '"1 reviews"'),
]


def rules_from_discover():
    """CHAINS and NOT_A_PLACE as Discover defines them (so the eval can't drift from the code)."""
    src = (ROOT / "supabase/functions/capture/discover.ts").read_text()

    def grab(name):
        m = re.search(rf"const {name} = /(.+?)/(\w*);", src)
        if not m:
            raise SystemExit(f"Couldn't find {name} in discover.ts")
        return re.compile(m.group(1).replace("\\/", "/"), re.I if "i" in m.group(2) else 0)

    return grab("CHAINS"), grab("NOT_A_PLACE")


# ---------- what the place card shows ----------
# The card's rules for hiding a line, as in app/src/components/PlaceCard.tsx (REVIEWS_ONLY is read from there).
CARD_TOP = 25  # cards checked per place: the ones people are likely to open
REVIEW_MENTION = re.compile(r"\breviews?\b|\bfew reviews\b", re.I)
REVIEW_NUMBER = re.compile(r"(\d[\d,]*) reviews?\b|\((\d[\d,]*)\)", re.I)
OLD_PLACE = re.compile(r"institution|since (1[89]|20)\d\d|long-running|old-school|classic|decades|landmark", re.I)


def card_rules():
    src = (ROOT / "app/src/components/PlaceCard.tsx").read_text()
    m = re.search(r"const REVIEWS_ONLY = /(.+?)/(\w*);", src)
    if not m:
        raise SystemExit("Couldn't find REVIEWS_ONLY in PlaceCard.tsx")
    return re.compile(m.group(1), re.I if "i" in m.group(2) else 0)


def rating_text(rating, count):
    """As ratingText in app/src/lib/format.ts."""
    if not rating:
        return None
    count = count or 0
    if count < 20:
        return f"{count} review{'' if count == 1 else 's'}"
    return f"{rating:.1f} ★ ({count:,})"


def card_lines(p, reviews_only):
    """The text lines a suggestion's card shows, in order, with where each comes from."""
    lines = []
    if p.get("just_opened"):
        note = p.get("opened_note") or ""
        lines.append(("just opened", "Just opened" + (f"  {note}" if note and not re.search(r"reviews? on Google", note, re.I) else "")))
    facts = rating_text(p.get("rating"), p.get("reviews"))
    if facts:
        lines.append(("rating", facts))
    note = (p.get("note") or "").strip()
    if note and not reviews_only.search(note):
        lines.append(("about it", note))
    why = (p.get("why") or "").strip()
    if why and not re.match(r"From ", why):
        lines.append(("reason", why))
    return lines


def check_card(p, reviews_only):
    """Repeated or contradictory information on one card."""
    lines = card_lines(p, reviews_only)
    flags = []
    mentions = [src for src, text in lines if REVIEW_MENTION.search(text)]
    if len(mentions) > 1:
        flags.append(f"card repeats the review count ({', '.join(mentions)})")
    numbers = set()
    for _src, text in lines:
        for m in REVIEW_NUMBER.finditer(text):
            numbers.add(int((m.group(1) or m.group(2)).replace(",", "")))
    if len(numbers) > 1:
        flags.append(f"card gives different review counts ({', '.join(str(n) for n in sorted(numbers))})")
    if p.get("just_opened"):
        if (p.get("reviews") or 0) >= 100:
            flags.append(f"card says just opened, but {p['reviews']} reviews")
        if any(OLD_PLACE.search(text) for src, text in lines if src != "just opened"):
            flags.append("card says just opened, and also long-established")
    texts = [text.lower() for _src, text in lines]
    if len(texts) != len(set(texts)):
        flags.append("card shows the same line twice")
    return flags


def norm_name(s):
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower().replace("’", "'")).strip()


def km(a, b):
    r = math.radians
    dlat, dlng = r(b[0] - a[0]), r(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(dlng / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


# ---------- the eval account ----------

def http(method, url, body=None, headers=None, timeout=60):
    req = urllib.request.Request(url, method=method, headers=headers or {},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} from {url.split('?')[0]}: {e.read().decode()[:300]}")


def key_headers():
    key = os.environ["SUPABASE_SECRET_KEY"]
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_"):
        h["Authorization"] = f"Bearer {key}"
    return h


def eval_session(con):
    """Create or reset the eval account with a fresh password, sign in, return (uid, access token)."""
    base = os.environ["SUPABASE_URL"].rstrip("/")
    password = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(24))
    row = con.execute("SELECT id FROM auth.users WHERE lower(email) = lower(%s)", (EVAL_EMAIL,)).fetchone()
    if row:
        http("PUT", f"{base}/auth/v1/admin/users/{row[0]}", {"password": password, "email_confirm": True}, key_headers())
    else:
        http("POST", f"{base}/auth/v1/admin/users", {"email": EVAL_EMAIL, "password": password, "email_confirm": True}, key_headers())
    tok = http("POST", f"{base}/auth/v1/token?grant_type=password", {"email": EVAL_EMAIL, "password": password}, key_headers())
    return tok["user"]["id"], tok["access_token"]


def capture(token, body, timeout=170):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    h = key_headers()
    h["Authorization"] = f"Bearer {token}"
    return http("POST", f"{base}/functions/v1/capture", body, h, timeout=timeout)


def copy_taste(con, src_uid, dst_uid):
    """The eval account gets the source user's taste: profile, edits, places, answers. Its own picks are cleared."""
    cols = [r[0] for r in con.execute(
        """SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='places' AND column_name NOT IN ('id', 'user_id')
           ORDER BY ordinal_position""")]
    collist = ", ".join(cols)
    with con.transaction():
        for t in ("places", "user_prefs", "feedback", "cleared_picks", "pick_scores", "user_profiles"):
            con.execute(f"DELETE FROM {t} WHERE user_id = %s", (dst_uid,))
        con.execute(f"INSERT INTO places (user_id, {collist}) SELECT %s, {collist} FROM places WHERE user_id = %s",
                    (dst_uid, src_uid))
        con.execute("""INSERT INTO user_prefs (user_id, kind, value, raw, created_at)
                       SELECT %s, kind, value, raw, created_at FROM user_prefs WHERE user_id = %s""", (dst_uid, src_uid))
        con.execute("""INSERT INTO feedback (user_id, google_place_id, name, reaction, note, created_at)
                       SELECT %s, google_place_id, name, reaction, note, created_at FROM feedback WHERE user_id = %s""",
                    (dst_uid, src_uid))
        con.execute("""INSERT INTO user_profiles (user_id, profile, updated_at)
                       SELECT %s, profile, now() FROM user_profiles WHERE user_id = %s""", (dst_uid, src_uid))
        con.execute("UPDATE app_users SET discover_web_per_day = 50, home = (SELECT home FROM app_users WHERE user_id = %s) "
                    "WHERE user_id = %s", (src_uid, dst_uid))
    n = con.execute("SELECT count(*) FROM places WHERE user_id = %s", (dst_uid,)).fetchone()[0]
    return n


# ---------- one place ----------

def suggestions(con, uid, lat, lng, started):
    """What the eval account's list shows there (Best match order), with type and status from the pool."""
    with con.transaction():
        con.execute("SELECT set_config('request.jwt.claim.sub', %s, true), "
                    "set_config('request.jwt.claims', %s, true)", (uid, json.dumps({"sub": uid, "role": "authenticated"})))
        rows = con.execute("""
            SELECT n.name, n.google_place_id, n.distance_m, n.categories, n.rating, n.review_count, n.score, n.why,
                   n.note, n.just_opened, n.opened_note,
                   n.place_lat, n.place_lng, c.primary_type, c.business_status, c.source,
                   ps.updated_at >= %s AS this_run
            FROM public.nearby(%s, %s, %s, 300, null) n
            LEFT JOIN LATERAL (SELECT primary_type, business_status, source FROM candidates
                               WHERE google_place_id = n.google_place_id ORDER BY created_at DESC LIMIT 1) c ON true
            LEFT JOIN pick_scores ps ON ps.user_id = %s AND ps.google_place_id = n.google_place_id
            WHERE n.kind = 'pick'
            ORDER BY n.score DESC NULLS LAST, n.distance_m""", (started, lat, lng, LIST_M, uid)).fetchall()
    keys = ("name", "gid", "distance_m", "categories", "rating", "reviews", "score", "why", "note", "just_opened",
            "opened_note", "lat", "lng",
            "primary_type", "status", "source", "this_run")
    picks = [dict(zip(keys, r)) for r in rows]
    # as the app does: one suggestion per name (branches of the same place), the nearest
    nearest = {}
    for p in picks:
        k = norm_name(p["name"])
        if k not in nearest or p["distance_m"] < nearest[k]["distance_m"]:
            nearest[k] = p
    keep = {id(p) for p in nearest.values()}
    return [p for p in picks if id(p) in keep]


def far_scored(con, uid, lat, lng, started):
    """Suggestions this run scored that are far from the search (they wouldn't show in the list there)."""
    rows = con.execute("""
        SELECT DISTINCT ON (ps.google_place_id) c.google_name, ps.google_place_id,
               ST_Y(c.location::geometry), ST_X(c.location::geometry)
        FROM pick_scores ps JOIN candidates c ON c.google_place_id = ps.google_place_id
        WHERE ps.user_id = %s AND ps.updated_at >= %s AND c.location IS NOT NULL""", (uid, started)).fetchall()
    out = []
    for name, gid, plat, plng in rows:
        d = km((lat, lng), (plat, plng))
        if d > FAR_KM:
            out.append({"name": name, "gid": gid, "km": round(d)})
    return out


def check(picks, known, chains, not_place, reviews_only):
    seen = {}
    for p in picks:
        flags = []
        name = p["name"] or ""
        if chains.search(name.strip().replace("’", "'")):
            flags.append("chain")
        t = p["primary_type"] or ((p["categories"] or [None])[0])
        if t and not_place.search(t):
            flags.append(f"not a place to eat ({t.replace('_', ' ')})")
        if (p["status"] or "OPERATIONAL") != "OPERATIONAL":
            flags.append(f"not open ({p['status']})")
        # the rating bar is for places found by Google search; an article or a city's institutions outweigh it
        if (p["source"] == "Google Maps search" and p["rating"] and (p["reviews"] or 0) >= 20 and p["rating"] < 4.3
                and not re.search(r"institution|specialty", p["why"] or "", re.I)):
            flags.append(f"rated {p['rating']}")
        if p["gid"] in known:
            flags.append("already saved or turned down")
        k = norm_name(name)
        if k in seen:
            flags.append(f"same name as #{seen[k]}")
        seen.setdefault(k, p["rank"])
        why = (p["why"] or "").strip()
        if p["this_run"] and not why:
            flags.append("no reason")
        for rx, label in WORDING:
            if rx.search(why) or rx.search(name):
                flags.append(label)
        if p["rank"] <= CARD_TOP:
            flags += check_card(p, reviews_only)
        p["flags"] = flags
        p["generic"] = bool(GENERIC.search(why))
    return picks


def run_place(con, token, uid, place, web, known, rules, log):
    key, name, lat, lng, why_here = place
    started = datetime.now(timezone.utc)
    res = {"key": key, "name": name, "why": why_here, "errors": []}
    t0 = time.time()
    for mode in (["google", "web"] if web else ["google"]):
        try:
            r = capture(token, {"type": "discover", "mode": mode, "lat": lat, "lng": lng, "radius_m": RADIUS_M, "area_name": name})
            res[mode] = {k: r.get(k) for k in ("places", "searched", "cached", "message", "away")}
        except Exception as e:  # noqa: BLE001
            res["errors"].append(f"{mode}: {e}")
    res["seconds"] = round(time.time() - t0)
    run = con.execute("SELECT id FROM discover_runs WHERE user_id = %s AND created_at >= %s ORDER BY id DESC LIMIT 1",
                      (uid, started)).fetchone()
    res["trace_id"] = run[0] if run else None
    picks = suggestions(con, uid, lat, lng, started)
    for i, p in enumerate(picks, 1):
        p["rank"] = i
    res["picks"] = check(picks, known, *rules)
    res["far"] = far_scored(con, uid, lat, lng, started)
    scored = [p for p in picks if p["this_run"]]
    res["counts"] = {
        "shown": len(picks), "scored_this_run": len(scored),
        "flagged": sum(1 for p in picks if p["flags"]), "generic_reasons": sum(1 for p in scored if p["generic"]),
    }
    problems = res["counts"]["flagged"] + len(res["far"]) + len(res["errors"]) + (1 if len(picks) < MIN_PICKS else 0)
    res["pass"] = problems == 0
    log(f"  {name}: {len(picks)} suggestions, {res['counts']['flagged']} flagged, {len(res['far'])} far, "
        f"{res['seconds']}s{'  ERRORS: ' + '; '.join(res['errors']) if res['errors'] else ''}")
    return res


# ---------- report ----------

def report_md(results, meta):
    out = [f"# Discover eval, {meta['when']}", "",
           f"Taste: {meta['user']} ({meta['places_copied']} saved places copied). Modes: {meta['modes']}. "
           f"Total time {meta['seconds']}s.", "",
           "| Place | Result | Suggestions | Flagged | Far | Generic reasons | Trace |",
           "|---|---|---|---|---|---|---|"]
    for r in results:
        c = r["counts"]
        out.append(f"| {r['name']} | {'pass' if r['pass'] else 'FAIL'} | {c['shown']} | {c['flagged']} | {len(r['far'])} | "
                   f"{c['generic_reasons']} of {c['scored_this_run']} | {r['trace_id'] or ''} |")
    for r in results:
        out += ["", f"## {r['name']}", f"_{r['why']}._"]
        if r["errors"]:
            out += ["", "Errors: " + "; ".join(r["errors"])]
        if len(r["picks"]) < MIN_PICKS:
            out += ["", f"Only {len(r['picks'])} suggestions (fewer than {MIN_PICKS})."]
        flagged = [p for p in r["picks"] if p["flags"]]
        if flagged:
            out += ["", "Flagged:"]
            out += [f"- #{p['rank']} {p['name']}: {', '.join(p['flags'])}" for p in flagged]
        if r["far"]:
            out += ["", f"Scored but more than {FAR_KM} km away:"]
            out += [f"- {f['name']} ({f['km']} km)" for f in r["far"]]
        out += ["", "Top 10 (mark the last column: would you save it?):", "",
                "| # | Place | Type | Rating | Reason | Save? |", "|---|---|---|---|---|---|"]
        for p in r["picks"][:10]:
            t = (p["primary_type"] or ((p["categories"] or [""])[0]) or "").replace("_", " ")
            rating = f"{p['rating']} ({p['reviews']})" if p["rating"] else ""
            cell = lambda x: (x or "").replace("|", "/").replace("\n", " ")  # noqa: E731
            out.append(f"| {p['rank']} | {cell(p['name'])} | {t} | {rating} | {cell(p['why'])} |  |")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="martin", help="whose taste to use (handle)")
    ap.add_argument("--web", action="store_true", help="also run the food-press search")
    ap.add_argument("--only", help="comma-separated place keys: " + ", ".join(p[0] for p in PLACES))
    args = ap.parse_args()
    load_env()
    for k in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
        if not os.environ.get(k):
            raise SystemExit(f"{k} must be in .env")
    places = PLACES
    if args.only:
        want = {x.strip() for x in args.only.split(",")}
        places = [p for p in PLACES if p[0] in want]
        if not places:
            raise SystemExit("No such place. Choose from: " + ", ".join(p[0] for p in PLACES))

    t0 = time.time()
    con = connect()
    rules = (*rules_from_discover(), card_rules())
    src = get_user(con, args.user)["uid"]
    print(f"Signing in the eval account ({EVAL_EMAIL})...")
    uid, token = eval_session(con)
    capture(token, {"type": "me"})  # makes its app_users row on first use
    n = copy_taste(con, src, uid)
    con.commit()
    print(f"Copied {args.user}'s taste ({n} saved places). Running {len(places)} places"
          f"{' with the food-press search' if args.web else ''}...")
    known = {r[0] for r in con.execute(
        """SELECT google_place_id FROM places WHERE user_id = %s AND google_place_id IS NOT NULL
           UNION SELECT google_place_id FROM feedback WHERE user_id = %s""", (uid, uid))}

    results = [run_place(con, token, uid, p, args.web, known, rules, print) for p in places]
    con.commit()

    when = datetime.now().strftime("%Y-%m-%d %H:%M")
    meta = {"when": when, "user": args.user, "places_copied": n, "modes": "google + web" if args.web else "google",
            "seconds": round(time.time() - t0)}
    outdir = ROOT / "evals" / "results"
    outdir.mkdir(parents=True, exist_ok=True)
    stem = datetime.now().strftime("%Y-%m-%d-%H%M")
    (outdir / f"{stem}.md").write_text(report_md(results, meta))
    (outdir / f"{stem}.json").write_text(json.dumps({"meta": meta, "results": results}, indent=1, default=str))
    passed = sum(1 for r in results if r["pass"])
    print(f"\n{passed} of {len(results)} places passed. Report: evals/results/{stem}.md")


if __name__ == "__main__":
    main()
