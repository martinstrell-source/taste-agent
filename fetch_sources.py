#!/usr/bin/env python3
"""Pull new Bay Area places from food feeds and match them on Google.

1. Read recent items from the feeds in FEEDS. Items already processed are skipped.
2. Claude (Haiku by default) lists the places each item names. For list articles and items
   whose feed text is short, the article page is fetched too, since feeds often carry only
   the intro. Passing mentions are stored but never recommended.
3. Each place is matched with Google Places Text Search, biased to the Bay Area.
Candidates are shared by all users. Whether a place is already on a given user's lists is
worked out per user in match.py.

Results go to tables feed_items and candidates in data/taste.db.

  python fetch_sources.py --limit-items 5     # small test
  python fetch_sources.py                     # items from the last 14 days
  python fetch_sources.py --days 30

Email newsletters are read too when NEWSLETTER_IMAP_USER / NEWSLETTER_IMAP_PASSWORD are in .env.
"""
import argparse
import calendar
import html
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

import anthropic
import feedparser

from common import SSL_CTX, connect, ensure_schema, is_food_types, load_env, name_similarity
from s2decode import haversine_m

ROOT = Path(__file__).parent
# Sonnet, not Haiku: Haiku returned empty lists on long articles. Feed extraction is shared
# across all users (one run per article, not per user), so the cost does not grow with users.
DEFAULT_MODEL = "claude-sonnet-5-5"
FEEDS = {
    "Eater SF": "https://sf.eater.com/rss/index.xml",
    "Tablehopper": "https://feeds.feedburner.com/Tablehopper",
    "SFist": "https://sfist.com/food/rss/",
    "SF Standard": "https://sfstandard.com/food-drink/feed",
    # Berkeleyside and Oaklandside return 403 to scripts (tested Oct 23), so no East Bay feed yet.
}
# Feed text is often just the intro. For these, fetch the article page as well.
LIST_TITLE = re.compile(r"\b(\d+\s+(best|essential|great|top|favorite|new)|best\b|where to|guide|map)", re.I)
SHORT_TEXT = 2500
BAY_CENTER = (37.7749, -122.2700)   # between SF and Oakland
BAY_RADIUS_M = 50000.0              # API maximum for locationBias
BAY_MAX_KM = 120                    # farther than this from center = not Bay Area
UA = "Mozilla/5.0 (Macintosh; TasteAgent prototype)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS feed_items (
    item_id TEXT PRIMARY KEY, source TEXT, title TEXT, link TEXT, published TEXT,
    fetched_at TEXT, n_places INTEGER, status TEXT, text_len INTEGER, text TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY,
    item_id TEXT, source TEXT, item_title TEXT, item_link TEXT, published TEXT,
    name TEXT, location_hint TEXT, mention_type TEXT, cuisine TEXT, dishes TEXT, what_it_says TEXT,
    google_place_id TEXT, google_name TEXT, address TEXT, lat REAL, lng REAL, categories TEXT,
    primary_type TEXT, business_status TEXT, maps_uri TEXT, name_similarity REAL,
    match_confidence TEXT, is_food INTEGER, in_bay_area INTEGER, already_saved INTEGER,
    created_at TEXT, tone TEXT,
    UNIQUE (item_id, name)
);
"""

SYSTEM = """You read one article or post from a San Francisco Bay Area food publication. List every specific restaurant, cafe, bakery, bar, shop or other food or drink business it names.

For each place:
- name: the business name as written.
- location_hint: neighborhood, street or city if the text gives one, else empty.
- mention_type: opening (new or coming soon), closing (closed or closing), review, list_entry (one entry in a roundup or "best of" list), news (other news about the place), passing (mentioned only in passing, e.g. a chef's previous restaurant).
- cuisine: short label if clear, else empty.
- dishes: specific dishes or drinks the text highlights there. Empty list if none.
- what_it_says: one plain line, under 20 words, on what the text says about it.
- tone: how the text rates it. positive (recommends it), mixed, negative (pans it or warns people off), neutral (news with no verdict).

Do not list chains mentioned only as comparisons, or places outside the Bay Area unless the article is clearly about them. If the article names no specific places, return an empty list.

Always respond by calling the record tool exactly once."""

TOOL = {
    "name": "record",
    "description": "Record the places named in this item.",
    "input_schema": {
        "type": "object",
        "properties": {
            "places": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "location_hint": {"type": "string"},
                        "mention_type": {"type": "string", "enum": [
                            "opening", "closing", "review", "list_entry", "news", "passing"]},
                        "cuisine": {"type": "string"},
                        "dishes": {"type": "array", "items": {"type": "string"}},
                        "what_it_says": {"type": "string"},
                        "tone": {"type": "string", "enum": ["positive", "mixed", "negative", "neutral"]},
                    },
                    "required": ["name", "location_hint", "mention_type", "cuisine", "dishes",
                                 "what_it_says", "tone"],
                },
            }
        },
        "required": ["places"],
    },
}


def clean_text(raw, limit=12000):
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    return " ".join(text.split())[:limit]


def fetch_feed(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        return feedparser.parse(resp.read())


def entry_text(e):
    if e.get("content"):
        return clean_text(" ".join(c.get("value", "") for c in e.content))
    return clean_text(e.get("summary", ""))


def article_text(url, limit=20000):
    """Fetch the article page and return its main text, or '' on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
            page = resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""
    # Pages often have several <article> blocks (cards, related links). Use the longest;
    # if that is still short, fall back to <main>, then the whole page.
    best = ""
    for block in re.findall(r"(?is)<article\b.*?</article>", page):
        t = clean_text(block, limit)
        if len(t) > len(best):
            best = t
    if len(best) < 1500:
        m = re.search(r"(?is)<main\b.*?</main>", page)
        t = clean_text(m.group(0), limit) if m else ""
        best = t if len(t) > len(best) else best
    if len(best) < 1500:
        t = clean_text(page, limit)
        best = t if len(t) > len(best) else best
    return best


def item_text(e):
    text = entry_text(e)
    title, link = e.get("title", ""), e.get("link", "")
    if link and (len(text) < SHORT_TEXT or LIST_TITLE.search(title)):
        full = article_text(link)
        if len(full) > len(text):
            return full, True
    return text, False


def entry_time(e):
    t = e.get("published_parsed") or e.get("updated_parsed")
    return calendar.timegm(t) if t else None


def extract_places(client, model, source, title, text):
    max_tokens = 8000
    for attempt in range(4):
        try:
            r = client.messages.create(
                model=model, max_tokens=max_tokens, system=SYSTEM, tools=[TOOL],
                tool_choice={"type": "auto"},
                messages=[{"role": "user", "content": f"Source: {source}\nTitle: {title}\n\n{text}"}],
            )
            if r.stop_reason == "max_tokens":
                # long lists can overflow; a cut-off tool call loses the whole list
                max_tokens = 16000
                continue
            block = next((b for b in r.content if b.type == "tool_use"), None)
            if block is not None:
                return block.input.get("places", []), r.usage
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"extraction failed: {title}")


def google_search(query):
    body = {"textQuery": query, "maxResultCount": 5,
            "locationBias": {"circle": {"center": {"latitude": BAY_CENTER[0], "longitude": BAY_CENTER[1]},
                                        "radius": BAY_RADIUS_M}}}
    req = urllib.request.Request(
        "https://places.googleapis.com/v1/places:searchText",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": os.environ["GOOGLE_MAPS_API_KEY"],
            "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.types,"
                                "places.formattedAddress,places.businessStatus,places.googleMapsUri,"
                                "places.primaryType",
        },
    )
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        return json.load(resp).get("places", [])


def match_place(name, hint):
    query = f"{name} {hint}".strip() if hint else f"{name} San Francisco Bay Area"
    cands = google_search(query)
    if not cands:
        return None
    best = max(cands, key=lambda p: name_similarity(name, p.get("displayName", {}).get("text", "")))
    sim = name_similarity(name, best.get("displayName", {}).get("text", ""))
    conf = "good" if sim >= 0.8 else "ok" if sim >= 0.6 else "weak"
    return best, sim, conf


# --- email newsletters -------------------------------------------------------------------
# Some publications (Berkeleyside Nosh, Oaklandside) block scripts on their sites but send free
# newsletters. Subscribe a dedicated inbox to them; this reads it over IMAP with an app password.
# .env: NEWSLETTER_IMAP_USER=..., NEWSLETTER_IMAP_PASSWORD=... (Gmail app password)
SKIP_SUBJECT = re.compile(r"\b(confirm|verify|verification|welcome|activate|password|receipt|unsubscribe)\b", re.I)


def fetch_newsletters(days):
    import email
    import email.header
    import email.utils
    import imaplib

    user, pw = os.environ.get("NEWSLETTER_IMAP_USER"), os.environ.get("NEWSLETTER_IMAP_PASSWORD")
    if not (user and pw):
        return []
    host = os.environ.get("NEWSLETTER_IMAP_HOST", "imap.gmail.com")
    since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - days * 86400))
    out = []
    with imaplib.IMAP4_SSL(host, ssl_context=SSL_CTX) as m:
        m.login(user, pw)
        m.select("INBOX", readonly=True)
        _, data = m.search(None, f'(SINCE "{since}")')
        for num in data[0].split():
            _, msg_data = m.fetch(num, "(RFC822)")
            msg = email.message_from_bytes(msg_data[0][1])

            def dec(v):
                return str(email.header.make_header(email.header.decode_header(v or "")))
            subject = dec(msg.get("Subject"))
            # real newsletters carry a List-Unsubscribe header; account mail (Google security
            # alerts, sign-in codes) does not
            if SKIP_SUBJECT.search(subject) or not msg.get("List-Unsubscribe"):
                continue
            from_name = email.utils.parseaddr(dec(msg.get("From")))[0] or dec(msg.get("From"))
            body_html, body_text = "", ""
            for part in msg.walk():
                ctype = part.get_content_type()
                if part.get_content_maintype() == "multipart" or part.get_filename():
                    continue
                payload = part.get_payload(decode=True) or b""
                text = payload.decode(part.get_content_charset() or "utf-8", "replace")
                if ctype == "text/html" and not body_html:
                    body_html = text
                elif ctype == "text/plain" and not body_text:
                    body_text = text
            ts = email.utils.parsedate_tz(msg.get("Date"))
            entry = feedparser.FeedParserDict(
                id=msg.get("Message-ID") or f"{from_name}:{subject}:{msg.get('Date')}",
                title=subject, link="",
                content=[feedparser.FeedParserDict(value=body_html or body_text)],
                published_parsed=time.gmtime(email.utils.mktime_tz(ts)) if ts else None,
            )
            out.append((f"Newsletter: {from_name}", entry))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--limit-items", type=int, default=0, help="stop after N new items (testing)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--redo", action="store_true", help="reprocess items already done")
    args = ap.parse_args()

    load_env()
    for k in ("ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY"):
        if not os.environ.get(k):
            sys.exit(f"{k} not set (put it in .env)")

    con = connect(args.db)
    ensure_schema(con)
    con.executescript(SCHEMA)
    have = {r[1] for r in con.execute("PRAGMA table_info(feed_items)")}
    for col in ("text_len INTEGER", "text TEXT"):
        if col.split()[0] not in have:
            con.execute(f"ALTER TABLE feed_items ADD COLUMN {col}")
    done = set() if args.redo else {r[0] for r in con.execute("SELECT item_id FROM feed_items")}
    client = anthropic.Anthropic()
    cutoff = time.time() - args.days * 86400

    new_items = []
    for source, url in FEEDS.items():
        try:
            feed = fetch_feed(url)
        except Exception as e:  # noqa: BLE001
            print(f"{source}: could not fetch ({e})")
            continue
        fresh = [e for e in feed.entries
                 if (entry_time(e) or time.time()) >= cutoff and (e.get("id") or e.get("link")) not in done]
        if not feed.entries:
            print(f"{source}: no items (feed URL may be wrong)")
            continue
        print(f"{source}: {len(feed.entries)} items in feed, {len(fresh)} new in the last {args.days} days")
        if source == "Tablehopper":
            # paid issues are gated; each has a "(free)" twin with the readable text
            fresh = [e for e in fresh if "(free)" in e.get("title", "")]
        new_items += [(source, e) for e in fresh]
    try:
        letters = [(src, e) for src, e in fetch_newsletters(args.days)
                   if (e.get("id")) not in done]
        if os.environ.get("NEWSLETTER_IMAP_USER"):
            print(f"Newsletters: {len(letters)} new emails in the last {args.days} days")
        new_items += letters
    except Exception as e:  # noqa: BLE001
        print(f"Newsletters: could not read the inbox ({e})")

    if args.limit_items:
        new_items = new_items[: args.limit_items]

    tin = tout = gcalls = n_places = 0
    for source, e in new_items:
        item_id = e.get("id") or e.get("link")
        title, link = e.get("title", ""), e.get("link", "")
        ts = entry_time(e)
        published = time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else ""
        try:
            text, fetched_page = item_text(e)
            places, usage = extract_places(client, args.model, source, title, text)
            tin += usage.input_tokens; tout += usage.output_tokens
        except Exception as ex:  # noqa: BLE001
            print(f"  extraction error on {title!r}: {ex}")
            continue

        con.execute("DELETE FROM candidates WHERE item_id = ?", (item_id,))
        for p in places:
            row = dict(google_place_id=None, google_name=None, address=None, lat=None, lng=None,
                       categories=None, primary_type=None, business_status=None, maps_uri=None,
                       name_similarity=None, match_confidence="no_match", is_food=None,
                       in_bay_area=None)
            try:
                gcalls += 1
                m = match_place(p["name"], p["location_hint"])
            except Exception as ex:  # noqa: BLE001
                print(f"  google error on {p['name']!r}: {ex}")
                m = None
            if m:
                g, sim, conf = m
                loc = g.get("location", {})
                lat, lng = loc.get("latitude"), loc.get("longitude")
                types = g.get("types", [])
                row.update(
                    google_place_id=g.get("id"), google_name=g.get("displayName", {}).get("text", ""),
                    address=g.get("formattedAddress"), lat=lat, lng=lng, categories=",".join(types),
                    primary_type=g.get("primaryType"), business_status=g.get("businessStatus"),
                    maps_uri=g.get("googleMapsUri"), name_similarity=round(sim, 3), match_confidence=conf,
                    is_food=1 if is_food_types(types) else 0,
                    in_bay_area=int(lat is not None and haversine_m(lat, lng, *BAY_CENTER) <= BAY_MAX_KM * 1000),
                )
            con.execute(
                """INSERT OR REPLACE INTO candidates
                   (item_id, source, item_title, item_link, published, name, location_hint, mention_type,
                    cuisine, dishes, what_it_says, google_place_id, google_name, address, lat, lng,
                    categories, primary_type, business_status, maps_uri, name_similarity,
                    match_confidence, is_food, in_bay_area, tone, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                (item_id, source, title, link, published, p["name"], p["location_hint"], p["mention_type"],
                 p["cuisine"], json.dumps(p["dishes"]), p["what_it_says"], row["google_place_id"],
                 row["google_name"], row["address"], row["lat"], row["lng"], row["categories"],
                 row["primary_type"], row["business_status"], row["maps_uri"], row["name_similarity"],
                 row["match_confidence"], row["is_food"], row["in_bay_area"], p.get("tone", "neutral")))
            n_places += 1
        con.execute("""INSERT OR REPLACE INTO feed_items
                       (item_id, source, title, link, published, fetched_at, n_places, status, text_len, text)
                       VALUES (?,?,?,?,?,datetime('now'),?,?,?,?)""",
                    (item_id, source, title, link, published, len(places), "done", len(text), text))
        con.commit()
        print(f"  {source}: {title[:70]}  -> {len(places)} places" + ("  (full page)" if fetched_page else ""))

    print(f"\nitems processed: {len(new_items)}, places stored: {n_places}, "
          f"Google calls: {gcalls}, Claude tokens: {tin} in / {tout} out")
    q = """SELECT count(*), count(DISTINCT CASE WHEN is_food=1 AND in_bay_area=1
                  AND coalesce(business_status,'OPERATIONAL')='OPERATIONAL'
                  AND mention_type NOT IN ('closing', 'passing') AND match_confidence<>'weak'
                  AND coalesce(tone,'neutral')<>'negative' THEN google_place_id END)
           FROM candidates"""
    total, usable = con.execute(q).fetchone()
    print(f"candidates in table: {total}; distinct places usable for picks: {usable or 0}")
    con.close()


if __name__ == "__main__":
    main()
