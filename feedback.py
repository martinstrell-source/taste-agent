#!/usr/bin/env python3
"""Record a user's reaction to a place.

Reactions: love (been, liked it), meh (been, would not go back), no (not interested), want (would save it).

  python feedback.py alex "Golden Boy" no --note "never got the hype"
  python feedback.py alex --list
"""
import argparse

from common import REACTIONS, connect, ensure_schema, get_user, name_similarity


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("user_id")
    ap.add_argument("place", nargs="?")
    ap.add_argument("reaction", nargs="?", choices=sorted(REACTIONS))
    ap.add_argument("--note", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--db")
    args = ap.parse_args()

    con = connect(args.db)
    ensure_schema(con)
    get_user(con, args.user_id)
    if args.list or not args.place:
        for row in con.execute("SELECT name, reaction, note, created_at FROM feedback WHERE user_id=? "
                               "ORDER BY created_at", (args.user_id,)):
            print(row)
        return
    if not args.reaction:
        raise SystemExit("give a reaction: " + ", ".join(sorted(REACTIONS)))

    # find the place among feed candidates first, then the user's own saves
    rows = con.execute("SELECT DISTINCT google_place_id, google_name, address FROM candidates "
                       "WHERE google_place_id IS NOT NULL").fetchall()
    rows += con.execute("SELECT DISTINCT google_place_id, google_name, address FROM places "
                        "WHERE user_id=? AND google_place_id IS NOT NULL", (args.user_id,)).fetchall()
    scored = sorted(((name_similarity(args.place, r[1] or ""), r) for r in rows), key=lambda x: -x[0])
    if not scored or scored[0][0] < 0.6:
        raise SystemExit(f"no place matching '{args.place}'")
    top = [r for sim, r in scored if sim >= scored[0][0] - 0.001]
    if len({r[0] for r in top}) > 1:
        print("several matches, be more specific:")
        for r in top[:8]:
            print(f"  {r[1]} | {r[2]}")
        return
    gid, name, addr = top[0]
    con.execute("INSERT OR REPLACE INTO feedback (user_id, google_place_id, name, reaction, note) VALUES (?,?,?,?,?)",
                (args.user_id, gid, name, args.reaction, args.note))
    con.commit()
    print(f"{args.user_id}: {name} ({addr}) -> {args.reaction}")


if __name__ == "__main__":
    main()
