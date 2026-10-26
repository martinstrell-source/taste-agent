#!/usr/bin/env python3
"""Build a user's weekly digest as an HTML email (preview only; sending comes later).

Takes the top new picks from match.py and gives each one enough to decide on:
neighborhood, cuisine, price, Google rating (or "new" when there are too few reviews),
every article's take including negative ones, dishes, a map link, and a one-line reason
from Claude. Places that are relocating are left out. Reply links open a pre-filled email
(want / been, loved it / been, meh / not for me) until there is a backend for one-tap buttons.

  python digest.py --user martin            # writes data/digests/martin-YYYY-MM-DD.html
  python digest.py --user martin --n 8 --no-explain

Reply links go to DIGEST_REPLY_TO in .env (your address). Without it, they are left out.
"""
import argparse
import html
import os
import time
import urllib.parse
from pathlib import Path

from common import connect, ensure_schema, get_user, load_env
from match import add_ratings, explain, load_profile, neighborhood, rank_places

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "data" / "digests"
NEW_UNDER_REVIEWS = 20
REPLIES = [("want", "Want to try"), ("love", "Been, loved it"), ("meh", "Been, meh"), ("no", "Not for me")]
TONE_LABEL = {"negative": "negative review", "mixed": "mixed review"}

E = html.escape


def kinds(p):
    labels = [c.replace("_", " ") for c in p["cuisines"]]
    labels += [f for f in p["formats"] if f not in ("restaurant",) and f not in labels]
    labels = [x[:1].upper() + x[1:] for x in dict.fromkeys(labels)]
    return ", ".join(labels) or "Restaurant"


def area(p):
    """Neighborhood from the article when it gives one ('566 Columbus Ave, North Beach' -> 'North Beach'),
    else the city from Google's address."""
    parts = [x.strip() for x in (p.get("area") or "").split(",")]
    parts = [x for x in parts if x and not x[0].isdigit() and x.lower() not in ("san francisco", "sf")]
    a = parts[0] if parts else ""
    return a if a and len(a) <= 30 else neighborhood(p["address"])


def rating_line(p):
    n = p.get("review_count")
    if p.get("rating") is None:
        return "No Google rating yet"
    if n is not None and n < NEW_UNDER_REVIEWS:
        return f"New: {n} Google review{'s' if n != 1 else ''} so far"
    return f"&#9733; {p['rating']:.1f} on Google ({n:,} reviews)"


def reply_links(p, user, reply_to):
    if not reply_to:
        return ""
    links = []
    for code, label in REPLIES:
        q = urllib.parse.urlencode({
            "subject": f"Taste Agent: {p['name']} = {code}",
            "body": f"user: {user['user_id']}\nplace: {p['name']}\nid: {p['google_place_id']}\nreaction: {code}\n\n"
                    "Anything else? (optional)\n",
        }, quote_via=urllib.parse.quote)
        links.append(f'<a href="mailto:{E(reply_to)}?{q}" style="display:inline-block;margin:4px 6px 0 0;'
                     f'padding:6px 10px;border:1px solid #c9c2b8;border-radius:14px;color:#3d3a35;'
                     f'text-decoration:none;font-size:13px">{E(label)}</a>')
    return '<div style="margin-top:10px">' + "".join(links) + "</div>"


def card(p, i, user, reply_to):
    price = f" &middot; {E(p['price'])}" if p.get("price") else ""
    takes = []
    for m in p.get("mentions", []):
        tag = TONE_LABEL.get(m["tone"])
        tag_html = (f' <span style="color:#a2452c;font-size:12px">({E(tag)})</span>' if tag else "")
        takes.append(
            f'<li style="margin:4px 0"><b>{E(m["source"])}</b>{tag_html}: {E(m["what_it_says"] or "")} '
            f'<a href="{E(m["link"])}" style="color:#7a5c2e">Read</a></li>')
    dishes = (f'<div style="margin-top:6px;font-size:14px"><b>Dishes:</b> {E(", ".join(p["dishes"][:5]))}</div>'
              if p["dishes"] else "")
    why = (f'<div style="margin-top:8px;font-size:15px;color:#3d3a35">{E(p["why"])}</div>' if p.get("why") else "")
    return f"""
<tr><td style="padding:18px 0;border-top:1px solid #e6e0d6">
  <div style="font-size:12px;color:#8a8378">{i}</div>
  <a href="{E(p.get('maps_uri') or '')}" style="font-size:19px;font-weight:bold;color:#2b2925;text-decoration:none">{E(p['name'])}</a>
  <div style="font-size:14px;color:#5c574f;margin-top:2px">{E(area(p))} &middot; {E(kinds(p))}{price}</div>
  <div style="font-size:14px;color:#5c574f;margin-top:2px">{rating_line(p)}</div>
  {why}
  <ul style="margin:8px 0 0 18px;padding:0;font-size:14px;color:#3d3a35">{''.join(takes)}</ul>
  {dishes}
  <div style="margin-top:6px;font-size:13px;color:#8a8378">{E(p['address'] or '')} &middot;
    <a href="{E(p.get('maps_uri') or '')}" style="color:#7a5c2e">Map</a></div>
  {reply_links(p, user, reply_to)}
</td></tr>"""


def render(user, picks, reply_to, sources):
    date = time.strftime("%B %-d, %Y")
    name = user.get("display_name") or user["user_id"]
    cards = "".join(card(p, i, user, reply_to) for i, p in enumerate(picks, 1))
    reply_note = ("Tap a reply under any place and send the email. That is how Taste Agent learns." if reply_to
                  else "")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Taste Agent picks for {E(name)}, {E(date)}</title></head>
<body style="margin:0;padding:0;background:#f6f3ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ee">
<tr><td align="center" style="padding:20px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="max-width:600px;background:#fffdf9;border-radius:10px;padding:8px 22px 22px;
              font-family:-apple-system,Helvetica,Arial,sans-serif;color:#2b2925">
<tr><td style="padding:18px 0 10px">
  <div style="font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#8a8378">Taste Agent &middot; {E(date)}</div>
  <div style="font-size:22px;font-weight:bold;margin-top:4px">{len(picks)} new places for {E(name)}</div>
  <div style="font-size:14px;color:#5c574f;margin-top:6px">Picked from this week's Bay Area food coverage to fit
  what you save. {reply_note}</div>
</td></tr>
{cards}
<tr><td style="padding-top:18px;border-top:1px solid #e6e0d6;font-size:12px;color:#8a8378">
  Sources this week: {E(", ".join(sources))}. Ratings from Google. Places already on your lists are left out.
</td></tr>
</table></td></tr></table></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--n", type=int, default=7)
    ap.add_argument("--no-explain", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()

    load_env()
    con = connect()
    ensure_schema(con)
    user = get_user(con, args.user)
    prof = load_profile(con, user)
    ranked = rank_places(con, user, prof)
    pool = [p for p in ranked if p["known"] is None and not p.get("moving")]
    picks = pool[: args.n]
    add_ratings(con, picks)
    if not args.no_explain:
        explain(picks, prof)

    sources = sorted({m["source"] for p in picks for m in p["mentions"]})
    reply_to = os.environ.get("DIGEST_REPLY_TO", "")
    page = render(user, picks, reply_to, sources)

    day = time.strftime("%Y-%m-%d")
    out = Path(args.out) if args.out else OUT_DIR / f"{args.user}-{day}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")

    con.cursor().executemany(
        """INSERT INTO digest_items (user_id, digest_date, google_place_id, position, score, name, why)
           VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (user_id, digest_date, google_place_id) DO UPDATE SET position=excluded.position,
           score=excluded.score, name=excluded.name, why=excluded.why""",
        [(user["uid"], day, p["google_place_id"], i, p["score"], p["name"], p.get("why"))
         for i, p in enumerate(picks, 1)])
    con.commit()
    con.close()

    for i, p in enumerate(picks, 1):
        print(f"{i}. {p['name']} ({area(p)})")
    skipped = [p["name"] for p in ranked if p["known"] is None and p.get("moving")]
    if skipped:
        print("left out (relocating):", ", ".join(skipped))
    print(f"\nwrote {out}\nopen it with: open '{out}'")


if __name__ == "__main__":
    main()
