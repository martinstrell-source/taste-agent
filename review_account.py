#!/usr/bin/env python3
"""Creates (or resets) the sign-in account for Apple's TestFlight reviewer: an email and a password,
since the reviewer can't receive the emailed sign-in code. Prints the password once, here in Terminal;
type it into App Store Connect (TestFlight > Test Information > Sign-in required). It is not saved anywhere.

  python review_account.py                       # tasteagent.martin+review@gmail.com
  python review_account.py --email someone@example.com
Running it again sets a new password.
"""
import argparse
import json
import os
import secrets
import string
import urllib.error
import urllib.request

from common import SSL_CTX, connect, load_env

DEFAULT_EMAIL = "tasteagent.martin+review@gmail.com"


def admin(method, path, body=None):
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        raise SystemExit("SUPABASE_URL and SUPABASE_SECRET_KEY must be in .env")
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_"):
        h["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url.rstrip("/") + "/auth/v1/admin" + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Supabase said HTTP {e.code}: {e.read().decode()[:300]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", default=DEFAULT_EMAIL)
    args = ap.parse_args()
    load_env()
    # letters and digits only, so it's easy to type into App Store Connect
    password = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))

    con = connect()
    row = con.execute("SELECT id FROM auth.users WHERE lower(email) = lower(%s)", (args.email,)).fetchone()
    con.close()
    if row:
        admin("PUT", f"/users/{row[0]}", {"password": password, "email_confirm": True})
        print(f"Reset the password for {args.email}")
    else:
        admin("POST", "/users", {"email": args.email, "password": password, "email_confirm": True})
        print(f"Created {args.email}")
    print("\nFor App Store Connect (TestFlight > Test Information > Sign-in required):")
    print(f"  User name: {args.email}")
    print(f"  Password:  {password}")
    print("\nIn the app: on the sign-in screen, tap 'Sign in with a password'.")


if __name__ == "__main__":
    main()
