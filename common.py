"""Shared helpers: paths, .env, Supabase (Postgres) connection, users, name matching.

The scripts talk to Supabase's Postgres database directly, as the database owner, so row level
security does not apply to them. Connection string: SUPABASE_DB_URL in .env (Supabase dashboard >
Connect > Session pooler). New sign-in accounts are created through the Auth API, which needs
SUPABASE_URL and SUPABASE_SECRET_KEY.
"""
import json
import os
import re
import ssl
import unicodedata
import urllib.error
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).parent
DB_PATH = ROOT / "data" / "taste.db"  # the old SQLite database; only migrate_to_supabase.py reads it

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


def connect(url=None):
    """Open a connection to the Supabase database. Call con.commit() to save writes."""
    import psycopg
    load_env()
    url = url or os.environ.get("SUPABASE_DB_URL")
    if not url:
        raise SystemExit("SUPABASE_DB_URL is not set. Add it to .env (Supabase > Connect > Session pooler).")
    con = psycopg.connect(url)
    con.execute("SET search_path TO public, extensions")  # PostGIS lives in the extensions schema
    return con


def jsonb(x):
    """Wrap a Python value for a jsonb column."""
    from psycopg.types.json import Jsonb
    return Jsonb(x)


def json_param(x):
    """Wrap a Python value for a json column (keeps key order)."""
    from psycopg.types.json import Json
    return Json(x)


# Locations are PostGIS points. Write them with pt(%s, %s) (lat, lng; defined in schema_v2.sql),
# read them back with lat_sql(col) / lng_sql(col).
def lat_sql(col):
    return f"ST_Y({col}::geometry)"


def lng_sql(col):
    return f"ST_X({col}::geometry)"


def cats_list(types):
    """Google types list -> value for a text[] column (None when empty)."""
    return list(types) or None


def ensure_schema(con):
    """Check that schema.sql and schema_v2.sql to schema_v7.sql have been run."""
    row = con.execute("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                      "WHERE n.nspname = 'public' AND p.proname = 'pt'").fetchone()
    if not row:
        raise SystemExit("The Supabase tables are missing or out of date. Run schema.sql, then schema_v2.sql, "
                         "then schema_v3.sql to schema_v7.sql, in the Supabase SQL Editor.")
    row = con.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
                      "AND table_name = 'places' AND column_name = 'removed_at'").fetchone()
    if not row:
        raise SystemExit("The places table is missing removed_at. Run schema_v3.sql in the Supabase SQL Editor.")
    row = con.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
                      "AND table_name = 'places' AND column_name = 'hidden_reason'").fetchone()
    if not row:
        raise SystemExit("The places table is missing hidden_reason. Run schema_v4.sql in the Supabase SQL Editor.")
    row = con.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
                      "AND table_name = 'places' AND column_name = 'list_set_in_app'").fetchone()
    if not row:
        raise SystemExit("The places table is missing list_set_in_app. Run schema_v5.sql in the Supabase SQL Editor.")
    row = con.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' "
                      "AND table_name = 'pick_scores'").fetchone()
    if not row:
        raise SystemExit("The pick_scores table is missing. Run schema_v6.sql in the Supabase SQL Editor.")
    row = con.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' "
                      "AND table_name = 'discover_runs'").fetchone()
    if not row:
        raise SystemExit("The discover_runs table is missing. Run schema_v7.sql in the Supabase SQL Editor.")


def get_user(con, handle):
    """Look up a user by handle ('martin'). user_id is the handle; uid is the Supabase account id."""
    row = con.execute(f"""SELECT user_id, handle, display_name, {lat_sql('home')}, {lng_sql('home')},
                                 home_label, email FROM app_users WHERE handle=%s""", (handle,)).fetchone()
    if not row:
        raise SystemExit(f"No user '{handle}'. Add one with: python users.py add {handle} --email ... "
                         "--name ... --home LAT,LNG")
    uid = row[0]
    shorthand = [dict(zip(("term", "type", "name", "description"), r)) for r in con.execute(
        "SELECT term, type, name, description FROM user_shorthand WHERE user_id=%s ORDER BY term", (uid,))]
    return {"uid": uid, "user_id": row[1], "display_name": row[2],
            "home": (row[3], row[4]) if row[3] is not None else None,
            "home_label": row[5], "email": row[6], "shorthand": shorthand}


def auth_user_id(con, email):
    """Supabase sign-in account id for this email, creating the account if there is none."""
    row = con.execute("SELECT id FROM auth.users WHERE lower(email) = lower(%s)", (email,)).fetchone()
    if row:
        return row[0]
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        raise SystemExit("SUPABASE_URL and SUPABASE_SECRET_KEY must be in .env to create a sign-in account.")
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_"):  # legacy JWT keys also go in Authorization
        h["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url.rstrip("/") + "/auth/v1/admin/users", method="POST", headers=h,
                                 data=json.dumps({"email": email, "email_confirm": True}).encode())
    try:
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            return json.loads(r.read())["id"]
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Could not create the sign-in account for {email}: HTTP {e.code} {e.read().decode()[:300]}")


def upsert_user(con, handle, email, name=None, home=None, label=None):
    """Create or update an app user. home is (lat, lng) or None. Returns the uid."""
    existing = con.execute("SELECT user_id, email FROM app_users WHERE handle=%s", (handle,)).fetchone()
    if existing:
        uid = existing[0]
    else:
        if not email:
            raise SystemExit(f"New user '{handle}' needs --email (it becomes their sign-in account).")
        uid = auth_user_id(con, email)
    lat, lng = home if home else (None, None)
    con.execute("""
        INSERT INTO app_users (user_id, handle, display_name, email, home, home_label)
        VALUES (%s, %s, %s, %s, pt(%s, %s), %s)
        ON CONFLICT (user_id) DO UPDATE SET
          handle = excluded.handle,
          display_name = coalesce(nullif(excluded.display_name, ''), app_users.display_name),
          email = coalesce(nullif(excluded.email, ''), app_users.email),
          home = coalesce(excluded.home, app_users.home),
          home_label = coalesce(nullif(excluded.home_label, ''), app_users.home_label)""",
                (uid, handle, name, email or None, lat, lng, label))
    return uid


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

REACTIONS = {"love", "meh", "no", "want"}


def is_food_types(types):
    return any(t in FOOD_TYPES or t.endswith("_restaurant") for t in types)


def dumps(x):
    return json.dumps(x, ensure_ascii=False)
