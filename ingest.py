#!/usr/bin/env python3
"""Load a user's Google Takeout saved lists into the database, and keep them in sync.

Takeout puts each Google Maps list in Takeout/Saved/ as its own CSV (Want to go, Favorite places,
custom lists). Pass one or more CSVs, or the Saved folder.
Given the folder, Google's own lists (Default list, Images, Screenshots, Saved for later) are skipped.

  python ingest.py --user martin data/Saved --dry-run   # show what would change, write nothing
  python ingest.py --user martin data/Saved
  python ingest.py --user martin "data/Favorite places.csv"

A place on more than one list keeps the strongest: favorites > want_to_go > other lists.

Re-running on a newer export brings the database in line with it, for the lists in the export:
- new places are added
- a place moved between lists follows it (e.g. taken off Favorites but still on Want to go)
- an edited, added or deleted note replaces the stored one; extract.py rereads it
- a place no longer on any list in the export is marked removed (removed_at), not deleted.
  Removed places leave the taste profile and Nearby but are never suggested as picks.
  A removed place that shows up again in a later export comes back.
Lists not in the export, and places added in the app or at signup, are left alone.
If more than 10% of a list (and more than 5 places) would be removed, nothing is written unless
--allow-removals is given (guards against a wrong or partial export).
"""
import argparse
import csv
import re
from pathlib import Path
from urllib.parse import unquote

from common import connect, ensure_schema, get_user

RANK = {"favorites": 3, "want_to_go": 2}
# Lists Google makes itself (Search collections, image and screenshot saves), not the user's own.
# Skipped when reading a whole Saved folder.
GOOGLE_LISTS = re.compile(r"^(default list\s*(\(\d+\))?|images|screenshots|saved for later)$", re.I)
REMOVAL_LIMIT = 0.10   # share of a list
REMOVAL_FLOOR = 5      # removing this many or fewer never trips the guard (small lists)


def rank(lname):
    return RANK.get(lname, 1)


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


def read_export(files):
    """place_key -> {lists: {list: note}, title, url, tags}; plus per-file counts."""
    export, report = {}, []
    for f in files:
        lname = list_name_for(f)
        with f.open(encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        unreadable = 0
        for r in rows:
            pid = extract_place_id(r.get("URL", ""))
            if not pid:
                unreadable += 1
                continue
            e = export.setdefault(pid, {"lists": {}, "title": (r.get("Title") or "").strip(),
                                        "url": (r.get("URL") or "").strip(),
                                        "tags": (r.get("Tags") or "").strip() or None})
            note = (r.get("Note") or "").strip()
            # same place twice on one list: keep the longer note
            if len(note) >= len(e["lists"].get(lname) or ""):
                e["lists"][lname] = note
        report.append((f.name, lname, len(rows), unreadable))
    return export, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--dry-run", action="store_true", help="show what would change, write nothing")
    ap.add_argument("--allow-removals", action="store_true",
                    help=f"write even if more than {REMOVAL_LIMIT:.0%} of a list would be removed")
    args = ap.parse_args()

    files, skipped_lists = [], []
    for p in map(Path, args.paths):
        p = p.expanduser()
        if p.is_dir():
            for f in sorted(p.glob("*.csv")):
                (skipped_lists if GOOGLE_LISTS.match(f.stem) else files).append(f)
        else:
            files.append(p)  # a file named on the command line is always read
    if skipped_lists:
        print("Skipped Google's own lists (name the file to read one anyway): "
              + ", ".join(f.name for f in skipped_lists) + "\n")
    if not files:
        raise SystemExit("No CSV files found.")

    export, report = read_export(files)
    in_export = {lname for _, lname, _, _ in report}

    con = connect()
    ensure_schema(con)
    uid = get_user(con, args.user)["uid"]

    stored = {r[0]: {"id": r[1], "list": r[2], "note": r[3] or "", "removed": r[4] is not None}
              for r in con.execute("SELECT place_key, id, list_name, note, removed_at FROM places "
                                   "WHERE user_id=%s AND added_via='takeout'", (uid,))}
    others = {r[0] for r in con.execute("SELECT place_key FROM places WHERE user_id=%s "
                                        "AND coalesce(added_via,'') <> 'takeout'", (uid,))}

    added, moved, notes_changed, removed, restored = [], [], [], [], []

    for pid, e in export.items():
        if pid in others:
            continue  # added in the app or at signup; leave it alone
        # the strongest list this place is on; a stored list that isn't in this export still counts
        candidates = dict(e["lists"])
        s = stored.get(pid)
        if s and s["list"] not in in_export and not s["removed"]:
            candidates[s["list"]] = s["note"]
        best = max(candidates, key=rank)
        note = candidates[best]
        if not note:  # the strongest list has no note: use one from another list if there is one
            note = next((n for l, n in sorted(candidates.items(), key=lambda x: -rank(x[0])) if n), "")

        if s is None:
            con.execute("INSERT INTO places (user_id, list_name, added_via, place_key, title, note, url, raw_tags) "
                        "VALUES (%s,%s,'takeout',%s,%s,%s,%s,%s)",
                        (uid, best, pid, e["title"], note or None, e["url"], e["tags"]))
            added.append((e["title"], best))
            continue
        if s["removed"]:
            con.execute("UPDATE places SET removed_at=NULL WHERE id=%s", (s["id"],))
            restored.append((e["title"], best))
        if best != s["list"]:
            con.execute("UPDATE places SET list_name=%s WHERE id=%s", (best, s["id"]))
            moved.append((e["title"], s["list"], best))
        if note != s["note"]:
            con.execute("UPDATE places SET note=%s WHERE id=%s", (note or None, s["id"]))
            # the old reading of the note no longer applies; extract.py reads the new one
            con.execute("DELETE FROM note_extractions WHERE user_id=%s AND place_key=%s", (uid, pid))
            notes_changed.append((e["title"], s["note"], note))

    titles = dict(con.execute("SELECT place_key, coalesce(google_name, title) FROM places WHERE user_id=%s",
                              (uid,)).fetchall())
    for pid, s in stored.items():
        if pid not in export and s["list"] in in_export and not s["removed"]:
            con.execute("UPDATE places SET removed_at=now() WHERE id=%s", (s["id"],))
            removed.append((titles.get(pid) or pid, s["list"]))

    # ---- report ----
    for name, lname, n, unreadable in report:
        print(f"{name} -> list '{lname}': {n} rows" + (f" ({unreadable} without a place link, skipped)"
                                                         if unreadable else ""))
    print(f"\nNew places:     {len(added)}")
    print(f"Moved lists:    {len(moved)}")
    print(f"Notes changed:  {len(notes_changed)}  (extract.py will reread these)")
    print(f"Removed:        {len(removed)}")
    print(f"Back again:     {len(restored)}  (removed earlier, on a list again)")

    def show(title, items, fmt, limit=15):
        if items:
            print(f"\n{title}:")
            for it in items[:limit]:
                print("  " + fmt(it))
            if len(items) > limit:
                print(f"  ... and {len(items) - limit} more")

    show("New", added, lambda x: f"{x[0]}  [{x[1]}]")
    show("Moved", moved, lambda x: f"{x[0]}: {x[1]} -> {x[2]}")
    show("Notes changed", notes_changed, lambda x: f"{x[0]}: {x[1][:50]!r} -> {x[2][:50]!r}")
    show("Removed", removed, lambda x: f"{x[0]}  [was {x[1]}]")
    show("Back again", restored, lambda x: f"{x[0]}  [{x[1]}]")

    # ---- guard against a wrong or partial export ----
    too_many = []
    for lname in sorted(in_export):
        before = sum(1 for s in stored.values() if s["list"] == lname and not s["removed"])
        gone = sum(1 for _, l in removed if l == lname)
        if gone > REMOVAL_FLOOR and gone / before > REMOVAL_LIMIT:
            too_many.append(f"{lname}: {gone} of {before} ({gone / before:.0%})")

    if args.dry_run:
        con.rollback()
        print("\nDry run: nothing written.")
        if too_many:
            print("A real run would stop here: more than 10% of a list would be removed ("
                  + "; ".join(too_many) + "). Check the export, or add --allow-removals.")
        return
    if too_many and not args.allow_removals:
        con.rollback()
        raise SystemExit("\nNothing written: more than 10% of a list would be removed ("
                         + "; ".join(too_many) + ").\nCheck that this is a complete, recent export. "
                         "If it is, run again with --allow-removals.")
    con.commit()

    print()
    for lname, n in con.execute("SELECT list_name, count(*) FROM places WHERE user_id=%s AND removed_at IS NULL "
                                "GROUP BY 1 ORDER BY 2 DESC", (uid,)).fetchall():
        print(f"  {args.user} / {lname}: {n}")
    print("next: extract.py and enrich.py for this user pick up only new places and changed notes")


if __name__ == "__main__":
    main()
