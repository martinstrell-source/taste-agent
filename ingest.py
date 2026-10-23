#!/usr/bin/env python3
"""Load a user's Google Takeout saved lists into the database.

Takeout puts each Google Maps list in Takeout/Saved/ as its own CSV (Want to go, Favorite places,
custom lists). Pass one or more CSVs, or the Saved folder.

  python ingest.py --user alex data/Want_to_go.csv
  python ingest.py --user alex "data/Favorite places.csv"
  python ingest.py --user sam ~/Downloads/Takeout/Saved

A place on more than one list keeps the strongest: favorites > want_to_go > other lists.
Notes are kept as written; extract.py reads them later.
"""
import argparse
import csv
import re
from pathlib import Path
from urllib.parse import unquote

from common import connect, ensure_schema, get_user

RANK = {"favorites": 3, "want_to_go": 2}


def list_name_for(path: Path) -> str:
    stem = path.stem.lower().replace("_", " ").strip()
    if stem.startswith("favorite"):
        return "favorites"
    if stem.startswith("want to go"):
        return "want_to_go"
    return re.sub(r"[^a-z0-9]+", "_", stem).strip("_") or "list"


def extract_place_id(url: str):
    m = re.search(r"(0x[0-9a-f]+:0x[0-9a-f]+)", unquote(url or ""))
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--db")
    args = ap.parse_args()

    con = connect(args.db)
    ensure_schema(con)
    get_user(con, args.user)

    files = []
    for p in map(Path, args.paths):
        files += sorted(p.expanduser().glob("*.csv")) if p.expanduser().is_dir() else [p.expanduser()]

    for f in files:
        lname = list_name_for(f)
        added = upgraded = skipped = 0
        with f.open(encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        for r in rows:
            pid = extract_place_id(r.get("URL", ""))
            if not pid:
                skipped += 1
                continue
            title = (r.get("Title") or "").strip()
            note = (r.get("Note") or "").strip()
            existing = con.execute("SELECT id, list_name, note FROM places WHERE user_id=? AND place_id=?",
                                   (args.user, pid)).fetchone()
            if existing is None:
                con.execute("INSERT INTO places (user_id, list_name, place_id, title, note, url, raw_tags) "
                            "VALUES (?,?,?,?,?,?,?)",
                            (args.user, lname, pid, title, note, (r.get("URL") or "").strip(),
                             (r.get("Tags") or "").strip()))
                added += 1
            else:
                rid, old_list, old_note = existing
                changed = False
                if RANK.get(lname, 1) > RANK.get(old_list, 1):
                    con.execute("UPDATE places SET list_name=? WHERE id=?", (lname, rid))
                    upgraded += 1
                    changed = True
                if note and not old_note:
                    # a note added on another list: clear the old extraction so it is redone
                    con.execute("UPDATE places SET note=? WHERE id=?", (note, rid))
                    con.execute("DELETE FROM note_extractions WHERE user_id=? AND place_id=?", (args.user, pid))
                    changed = True
                if not changed:
                    skipped += 1
        con.commit()
        print(f"{f.name} -> list '{lname}': {len(rows)} rows, {added} new, {upgraded} moved to this list, "
              f"{skipped} already there or unreadable")

    for lname, n in con.execute("SELECT list_name, count(*) FROM places WHERE user_id=? GROUP BY 1", (args.user,)):
        print(f"  {args.user} / {lname}: {n}")
    print("next: extract.py and enrich.py for this user pick up only the new places")


if __name__ == "__main__":
    main()
