#!/usr/bin/env python3
"""Manage users and their personal shorthand.

  python users.py add sam --name "Sam" --home 37.87,-122.27 --label Berkeley --email sam@example.com
  (a new user gets a Supabase sign-in account for that email)
  python users.py shorthand sam "J" person "Jordan" --desc "Sam's partner"
  python users.py show sam
  python users.py list
"""
import argparse

from common import connect, ensure_schema, get_user, upsert_user

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
    args = ap.parse_args()

    con = connect()
    ensure_schema(con)
    if args.cmd == "add":
        home = tuple(float(x) for x in args.home.split(",")) if args.home else None
        uid = upsert_user(con, args.user_id, args.email, args.name, home, args.label)
        print(f"saved user {args.user_id} ({uid})")
    elif args.cmd == "shorthand":
        u = get_user(con, args.user_id)
        con.execute("""INSERT INTO user_shorthand (user_id, term, type, name, description) VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (user_id, term) DO UPDATE SET type=excluded.type, name=excluded.name,
                       description=excluded.description""",
                    (u["uid"], args.term, args.type, args.name, args.desc))
        print(f"{args.user_id}: '{args.term}' = {args.name} ({args.type})")
    elif args.cmd == "show":
        u = get_user(con, args.user_id)
        print(u)
        for k, n in con.execute("SELECT list_name, count(*) FROM places WHERE user_id=%s GROUP BY 1 ORDER BY 2 DESC",
                                (u["uid"],)):
            print(f"  {k}: {n} places")
    else:
        for row in con.execute("SELECT u.handle, u.display_name, u.home_label, u.email, count(p.id) FROM app_users u "
                               "LEFT JOIN places p USING (user_id) GROUP BY 1, 2, 3, 4 ORDER BY 1"):
            print(row)
    con.commit()


if __name__ == "__main__":
    main()
