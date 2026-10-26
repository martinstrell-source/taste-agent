#!/usr/bin/env python3
"""Copy one user's data and the shared tables from the local SQLite database into Supabase.

- Creates (or finds) the user's Supabase sign-in account by email.
- Copies: user record, shorthand, signup prefs, places, note extractions, feedback, taste profile,
  digest items, plus shared feed items, candidates and ratings.
- Re-runnable: rows are upserted, so running it twice does not duplicate anything.
- Read-only on the SQLite side. data/taste.db is not changed.
- Run schema.sql and schema_v2.sql in the Supabase SQL Editor first.
- One-time. Once the pipeline scripts write to Supabase, do not rerun it: upserts would replace newer
  Supabase rows (feedback, profiles, enrichment) with the older SQLite copies.

  python migrate_to_supabase.py --user martin --email you@example.com
  python migrate_to_supabase.py --user martin --email you@example.com --dry-run
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

from common import DB_PATH, ROOT, SSL_CTX, load_env

BATCH = 500


def point(lat, lng):
    return f"SRID=4326;POINT({lng} {lat})" if lat is not None and lng is not None else None


def cats(s):
    return [c for c in (s or "").split(",") if c] or None


def js(s):
    if s is None or s == "":
        return None
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return None


def boolish(v):
    return None if v is None else bool(v)


class Supabase:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip("/"), key

    def _req(self, method, path, body=None, headers=None):
        h = {"apikey": self.key, "Content-Type": "application/json"}
        if not self.key.startswith("sb_"):          # legacy JWT keys also go in Authorization
            h["Authorization"] = f"Bearer {self.key}"
        h.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{method} {path} failed: HTTP {e.code} {e.read().decode()[:500]}")

    def user_id_for(self, email):
        page = 1
        while True:
            res = self._req("GET", f"/auth/v1/admin/users?page={page}&per_page=200")
            users = res.get("users", []) if isinstance(res, dict) else res
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return u["id"], False
            if len(users) < 200:
                break
            page += 1
        u = self._req("POST", "/auth/v1/admin/users", {"email": email, "email_confirm": True})
        return u["id"], True

    def upsert(self, table, rows, on_conflict):
        for i in range(0, len(rows), BATCH):
            self._req("POST", f"/rest/v1/{table}?on_conflict={on_conflict}", rows[i:i + BATCH],
                      {"Prefer": "resolution=merge-duplicates,return=minimal"})

    def count(self, table, filt=""):
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{table}?select=*{filt}", method="HEAD",
            headers={"apikey": self.key, "Prefer": "count=exact", "Range": "0-0",
                     **({} if self.key.startswith("sb_") else {"Authorization": f"Bearer {self.key}"})})
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            return int(r.headers.get("Content-Range", "*/0").split("/")[-1])


def build_rows(con, handle, uid, email):
    """Return {table: (rows, on_conflict)} in insert order."""
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    u = q("SELECT display_name, home_lat, home_lng, home_label FROM users WHERE user_id=?", handle)
    if not u:
        raise SystemExit(f"no user '{handle}' in the local database")
    name, hlat, hlng, hlabel = u[0]
    out = {}
    out["app_users"] = ([{"user_id": uid, "handle": handle, "display_name": name, "email": email,
                          "home": point(hlat, hlng), "home_label": hlabel}], "user_id")
    out["user_shorthand"] = ([{"user_id": uid, "term": t, "type": ty, "name": n, "description": d}
                              for t, ty, n, d in q("SELECT term, type, name, description FROM user_shorthand "
                                                   "WHERE user_id=?", handle)], "user_id,term")
    out["user_prefs"] = ([{"user_id": uid, "kind": k, "value": v, "raw": r}
                          for k, v, r in q("SELECT kind, value, raw FROM user_prefs WHERE user_id=?", handle)],
                         "user_id,kind,value")
    places = []
    for (pk, lname, title, note, url, gid, gname, addr, lat, lng, alat, alng, cat, food, conf, sim,
         dist, tags, ever) in q("""SELECT place_id, list_name, title, note, url, google_place_id, google_name,
                       address, lat, lng, approx_lat, approx_lng, categories, is_food, match_confidence,
                       name_similarity, match_distance_m, raw_tags, enrich_version
                       FROM places WHERE user_id=?""", handle):
        places.append({
            "user_id": uid, "place_key": pk, "list_name": lname,
            "added_via": "onboard" if (pk or "").startswith("onboard:") else "takeout",
            "title": title, "note": note or None, "url": url, "google_place_id": gid, "google_name": gname,
            "address": addr, "location": point(lat, lng), "approx_location": point(alat, alng),
            "categories": cats(cat), "is_food": boolish(food), "match_confidence": conf,
            "name_similarity": sim, "match_distance_m": dist, "raw_tags": tags or None,
            "enrich_version": ever})
    out["places"] = (places, "user_id,place_key")
    out["note_extractions"] = ([{
        "user_id": uid, "place_key": pk, "model": m, "dishes": js(d), "sources": js(s), "source_type": st,
        "source_name": sn, "intent": it, "kind": k, "cuisine": c or None, "sentiment": se,
        "constraints": js(co), "reason": r, "extracted_at": (ea + "Z") if ea else None,
        "input_tokens": ti, "output_tokens": to}
        for pk, m, d, s, st, sn, it, k, c, se, co, r, ea, ti, to in q(
            """SELECT place_id, model, dishes, sources, source_type, source_name, intent, kind, cuisine,
               sentiment, constraints, reason, extracted_at, input_tokens, output_tokens
               FROM note_extractions WHERE user_id=?""", handle)],
        "user_id,place_key")
    out["feedback"] = ([{"user_id": uid, "google_place_id": g, "name": n, "reaction": r, "note": no or None,
                         "created_at": (ca + "Z") if ca else None}
                        for g, n, r, no, ca in q("SELECT google_place_id, name, reaction, note, created_at "
                                                 "FROM feedback WHERE user_id=? ORDER BY rowid", handle)],
                       "user_id,google_place_id")
    prof = ROOT / "data" / "profiles" / f"{handle}.json"
    out["user_profiles"] = ([{"user_id": uid, "profile": json.loads(prof.read_text())}] if prof.exists() else [],
                            "user_id")
    out["digest_items"] = ([{"user_id": uid, "digest_date": d, "google_place_id": g, "position": p,
                             "score": s, "name": n}
                            for d, g, p, s, n in q("SELECT digest_date, google_place_id, position, score, name "
                                                   "FROM digest_items WHERE user_id=?", handle)],
                           "user_id,digest_date,google_place_id")
    # shared tables
    out["feed_items"] = ([{"item_id": i, "source": s, "title": t, "link": l, "published": p or None,
                           "fetched_at": (f + "Z") if f else None, "n_places": n, "status": st,
                           "text_len": tl, "text": tx}
                          for i, s, t, l, p, f, n, st, tl, tx in q(
                              "SELECT item_id, source, title, link, published, fetched_at, n_places, status, "
                              "text_len, text FROM feed_items")], "item_id")
    cand = []
    for r in q("""SELECT item_id, source, item_title, item_link, published, name, location_hint, mention_type,
                  tone, cuisine, dishes, what_it_says, google_place_id, google_name, address, lat, lng,
                  categories, primary_type, business_status, maps_uri, name_similarity, match_confidence,
                  is_food, in_bay_area FROM candidates"""):
        (iid, src, it, il, pub, nm, hint, mt, tone, cu, di, says, gid, gn, ad, lat, lng, cat, pt, bs, mu,
         sim, conf, food, bay) = r
        cand.append({"item_id": iid, "source": src, "item_title": it, "item_link": il, "published": pub or None,
                     "name": nm, "location_hint": hint, "mention_type": mt, "tone": tone, "cuisine": cu or None,
                     "dishes": js(di), "what_it_says": says, "google_place_id": gid, "google_name": gn,
                     "address": ad, "location": point(lat, lng), "categories": cats(cat), "primary_type": pt,
                     "business_status": bs, "maps_uri": mu, "name_similarity": sim, "match_confidence": conf,
                     "is_food": boolish(food), "in_bay_area": boolish(bay)})
    out["candidates"] = (cand, "item_id,name")
    out["place_ratings"] = ([{"google_place_id": g, "rating": r, "user_rating_count": n, "price_level": p,
                              "fetched_at": (f + "Z") if f else None}
                             for g, r, n, p, f in q("SELECT google_place_id, rating, user_rating_count, "
                                                    "price_level, fetched_at FROM place_ratings")],
                            "google_place_id")
    return out


ORDER = ["app_users", "user_shorthand", "user_prefs", "places", "note_extractions", "feedback",
         "user_profiles", "digest_items", "feed_items", "candidates", "place_ratings"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True, help="local user id, e.g. martin")
    ap.add_argument("--email", required=True, help="email for the Supabase sign-in account")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--dry-run", action="store_true", help="build the rows and report counts, send nothing")
    args = ap.parse_args()

    load_env()
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    if args.dry_run:
        rows = build_rows(con, args.user, "00000000-0000-0000-0000-000000000000", args.email)
        for t in ORDER:
            print(f"  {t}: {len(rows[t][0])} rows")
        return

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY must be in .env")
    sb = Supabase(url, key)
    uid, created = sb.user_id_for(args.email)
    print(f"Supabase account for {args.email}: {uid} ({'created' if created else 'already existed'})")

    rows = build_rows(con, args.user, uid, args.email)
    for t in ORDER:
        data, conflict = rows[t]
        if data:
            sb.upsert(t, data, conflict)
        print(f"  {t}: sent {len(data)}")

    print("\nChecking counts in Supabase:")
    ok = True
    for t in ORDER:
        want = len(rows[t][0])
        filt = "" if t in ("feed_items", "candidates", "place_ratings") else f"&user_id=eq.{uid}"
        have = sb.count(t, filt)
        flag = "ok" if have >= want else "MISSING"
        ok &= have >= want
        print(f"  {t}: local {want}, Supabase {have}  {flag}")
    print("\nDone." if ok else "\nSome rows are missing; paste this output to Claude.")


if __name__ == "__main__":
    main()
