"""Shared helpers: paths, .env, database connection, users, name matching."""
import json
import os
import re
import sqlite3
import ssl
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).parent
DB_PATH = ROOT / "data" / "taste.db"

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # python.org macOS builds need certifi for HTTPS
    SSL_CTX = ssl.create_default_context()


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def connect(db=None):
    con = sqlite3.connect(str(db or DB_PATH), check_same_thread=False)
    con.execute("PRAGMA foreign_keys = ON")
    return con


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    home_lat REAL, home_lng REAL, home_label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
-- personal shorthand found in a user's notes: "J" -> Jordan (person), "the group" -> a Facebook group
CREATE TABLE IF NOT EXISTS user_shorthand (
    user_id TEXT REFERENCES users(user_id),
    term TEXT, type TEXT, name TEXT, description TEXT,
    PRIMARY KEY (user_id, term)
);
CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    list_name TEXT,              -- want_to_go | favorites | <custom list name>
    place_id TEXT,               -- Google feature id from the Takeout URL (0x..:0x..)
    title TEXT, note TEXT, url TEXT, source TEXT, sentiment TEXT, raw_tags TEXT,
    lat REAL, lng REAL, categories TEXT, rating REAL, price_level TEXT, google_place_id TEXT,
    match_confidence TEXT, approx_lat REAL, approx_lng REAL, google_name TEXT, address TEXT,
    name_similarity REAL, match_distance_m REAL, is_food INTEGER, enrich_version INTEGER,
    UNIQUE (user_id, place_id)
);
CREATE TABLE IF NOT EXISTS note_extractions (
    user_id TEXT NOT NULL, place_id TEXT NOT NULL,
    model TEXT, dishes TEXT, source_type TEXT, source_name TEXT, intent TEXT, kind TEXT,
    cuisine TEXT, sentiment TEXT, constraints TEXT, reason TEXT, input_tokens INTEGER,
    output_tokens INTEGER, extracted_at TEXT, sources TEXT,
    PRIMARY KEY (user_id, place_id)
);
-- a user's reaction to a place (usually a suggested pick)
CREATE TABLE IF NOT EXISTS feedback (
    user_id TEXT NOT NULL REFERENCES users(user_id),
    google_place_id TEXT NOT NULL,
    name TEXT,
    reaction TEXT NOT NULL,      -- love (been, liked) | meh (been, would not return) | no (not interested) | want (would save)
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, google_place_id)
);
-- what a user told us directly at signup (no Google Maps history needed)
-- kind: cuisine | dish | format | source_<type> | dislike_cuisine | dislike_dish | dislike_format | dislike_other
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, raw TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, kind, value)
);
-- what each digest contained, for measuring saves from suggestions later
CREATE TABLE IF NOT EXISTS digest_items (
    user_id TEXT NOT NULL, digest_date TEXT NOT NULL, google_place_id TEXT NOT NULL,
    position INTEGER, score REAL, name TEXT,
    PRIMARY KEY (user_id, digest_date, google_place_id)
);
-- Google rating info, fetched only for places about to be shown as picks (Enterprise-tier fields)
CREATE TABLE IF NOT EXISTS place_ratings (
    google_place_id TEXT PRIMARY KEY,
    rating REAL, user_rating_count INTEGER, price_level TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
);
"""

REACTIONS = {"love", "meh", "no", "want"}


def ensure_schema(con):
    con.executescript(SCHEMA)
    cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
    if "email" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN email TEXT")


def get_user(con, user_id):
    row = con.execute("SELECT user_id, display_name, home_lat, home_lng, home_label, email FROM users "
                      "WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        raise SystemExit(f"No user '{user_id}'. Add one with: python users.py add {user_id} --name ... --home LAT,LNG")
    shorthand = [dict(zip(("term", "type", "name", "description"), r)) for r in con.execute(
        "SELECT term, type, name, description FROM user_shorthand WHERE user_id=? ORDER BY term", (user_id,))]
    return {"user_id": row[0], "display_name": row[1], "home": (row[2], row[3]) if row[2] is not None else None,
            "home_label": row[4], "email": row[5], "shorthand": shorthand}


def norm(s):
    """Lowercase, strip accents, keep letters/digits in any script."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    return " ".join(re.sub(r"[\W_]+", " ", s).split())


def name_similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


FOOD_TYPES = {
    "restaurant", "food", "cafe", "coffee_shop", "coffee_roastery", "bakery", "bar", "pub", "wine_bar",
    "winery", "brewery", "brewpub", "beer_garden", "cocktail_bar", "lounge_bar", "meal_takeaway",
    "meal_delivery", "ice_cream_shop", "dessert_shop", "tea_house", "juice_shop", "food_store",
    "market", "grocery_store", "supermarket", "confectionery", "deli", "sandwich_shop", "food_court",
    "bagel_shop", "donut_shop", "chocolate_shop", "candy_store", "pastry_shop", "cake_shop",
    "acai_shop", "bubble_tea_shop", "cafeteria", "diner", "bistro", "snack_bar", "farmers_market",
    "butcher_shop", "liquor_store", "asian_grocery_store", "chocolate_factory",
}


def is_food_types(types):
    return any(t in FOOD_TYPES or t.endswith("_restaurant") for t in types)


def dumps(x):
    return json.dumps(x, ensure_ascii=False)
