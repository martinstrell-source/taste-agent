#!/usr/bin/env python3
"""Manage users and their personal shorthand.

  python users.py add sam --name "Sam" --home 37.87,-122.27 --label Berkeley --email sam@example.com
  python users.py shorthand sam "J" person "Jordan" --desc "Sam's partner"
  python users.py show sam
  python users.py list
"""
import argparse

from common import connect, ensure_schema, get_user

TYPES = ["person", "community", "publication", "creator", "public_figure", "app"]


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("user_id")
    a.add_argument("--name", default="")
    a.add_argument("--home", help="LAT,LNG")
    a.add_argument("--label", default="")
    a.add_argument("--email", default="")
    s = sub.add_parser("shorthand")
    s.add_argument("user_id")
    s.add_argument("term")
    s.add_argument("type", choices=TYPES)
    s.add_argument("name")
    s.add_argument("--desc", default="")
    sh = sub.add_parser("show")
    sh.add_argument("user_id")
    sub.add_parser("list")
    ap.add_argument("--db")
    args = ap.parse_args()

    con = connect(args.db)
    ensure_schema(con)
    if args.cmd == "add":
        lat = lng = None
        if args.home:
            lat, lng = (float(x) for x in args.home.split(","))
        con.execute("INSERT OR REPLACE INTO users (user_id, display_name, home_lat, home_lng, home_label, email) "
                    "VALUES (?,?,?,?,?,?)", (args.user_id, args.name, lat, lng, args.label, args.email))
        print(f"saved user {args.user_id}")
    elif args.cmd == "shorthand":
        get_user(con, args.user_id)
        con.execute("INSERT OR REPLACE INTO user_shorthand VALUES (?,?,?,?,?)",
                    (args.user_id, args.term, args.type, args.name, args.desc))
        print(f"{args.user_id}: '{args.term}' = {args.name} ({args.type})")
    elif args.cmd == "show":
        u = get_user(con, args.user_id)
        print(u)
        for k, n in con.execute("SELECT list_name, count(*) FROM places WHERE user_id=? GROUP BY 1",
                                (args.user_id,)):
            print(f"  {k}: {n} places")
    else:
        for row in con.execute("SELECT u.user_id, u.display_name, u.home_label, count(p.id) FROM users u "
                               "LEFT JOIN places p USING (user_id) GROUP BY 1"):
            print(row)
    con.commit()


if __name__ == "__main__":
    main()
