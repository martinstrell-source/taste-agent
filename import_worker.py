#!/usr/bin/env python3
"""Runs the work the app queues in import_jobs. Scheduled on the Mac mini by launchd every 5 minutes
(see worker/). Each run takes queued jobs one at a time until none are left.

  takeout   a Google Maps Takeout file the user uploaded in the app (imports bucket):
            download, unzip, ingest.py, extract.py, enrich.py, profile.py, match.py for that user
  refresh   profile.py and match.py for that user (queued after onboarding)

The job row shows status (queued, running, done, failed), a short message for the app, and counts.
Each step's output goes to data/logs/imports-<date>.log.

  python import_worker.py            # run queued jobs
  python import_worker.py --once     # at most one job
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from common import SSL_CTX, connect, ensure_schema, load_env

ROOT = Path(__file__).resolve().parent
PY = sys.executable
STALE_HOURS = 3  # a 'running' job older than this was cut off (Mac asleep or restarted): mark it failed


def download(storage_path, dest):
    """Fetch a file from the private imports bucket with the secret key."""
    load_env()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be in .env")
    h = {"apikey": key}
    if not key.startswith("sb_"):  # legacy JWT keys also go in Authorization
        h["Authorization"] = f"Bearer {key}"
    target = url.rstrip("/") + "/storage/v1/object/imports/" + urllib.parse.quote(storage_path)
    req = urllib.request.Request(target, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=300, context=SSL_CTX) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"could not download the file (HTTP {e.code})")


def takeout_paths(src, work):
    """The Saved lists in what the user uploaded: a Takeout zip (any layout) or a CSV."""
    if zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".csv") and not n.startswith("__MACOSX")]
            for n in names:
                # zip slip guard: only plain relative paths
                p = Path(n)
                if p.is_absolute() or ".." in p.parts:
                    continue
                z.extract(n, work)
        csvs = [p for p in work.rglob("*.csv")]
    else:
        csv = work / "list.csv"
        shutil.copy(src, csv)
        csvs = [csv]
    # Takeout puts saved lists in a "Saved" folder; prefer that if present (other products have CSVs too)
    saved = sorted({p.parent for p in csvs if p.parent.name.lower() == "saved"})
    return [str(d) for d in saved] or [str(p) for p in csvs]


def run(step, log):
    log.write(f"\n--- {' '.join(step)}\n")
    log.flush()
    r = subprocess.run([PY, str(ROOT / step[0])] + step[1:], cwd=ROOT, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=2 * 60 * 60)
    log.write(r.stdout)
    log.write(f"--- exit {r.returncode}\n")
    log.flush()
    return r.returncode == 0, r.stdout


def counts(con, uid):
    n, food = con.execute("""SELECT count(*), count(*) FILTER (WHERE is_food) FROM places
                             WHERE user_id = %s AND removed_at IS NULL""", (uid,)).fetchone()
    return {"places": n, "food": food}


def finish(con, job_id, status, message, extra=None):
    con.execute("""UPDATE import_jobs SET status = %s, message = %s, counts = %s, finished_at = now()
                   WHERE id = %s""", (status, message[:500], json.dumps(extra) if extra else None, job_id))
    con.commit()


def claim(con):
    con.execute(f"""UPDATE import_jobs SET status = 'failed', finished_at = now(),
                      message = 'Stopped before finishing. Try the import again.'
                    WHERE status = 'running' AND started_at < now() - interval '{STALE_HOURS} hours'""")
    row = con.execute("""
        UPDATE import_jobs SET status = 'running', started_at = now()
        WHERE id = (SELECT id FROM import_jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, user_id, kind, storage_path""").fetchone()
    con.commit()
    return row


def do_job(con, job, log):
    job_id, uid, kind, storage_path = job
    h = con.execute("SELECT handle FROM app_users WHERE user_id = %s", (uid,)).fetchone()
    if not h or not h[0]:
        return finish(con, job_id, "failed", "No account found for this user.")
    handle = h[0]
    log.write(f"\n=== job {job_id}: {kind} for {handle} ({datetime.datetime.now():%H:%M})\n")

    if kind == "refresh":
        for step in (["profile.py", "--user", handle], ["match.py", "--user", handle, "--ratings", "0"]):
            ok, _ = run(step, log)
            if not ok:
                return finish(con, job_id, "failed", f"{step[0]} failed")
        return finish(con, job_id, "done", "Your taste profile and picks are ready.")

    # takeout
    before = counts(con, uid)
    work = ROOT / "data" / "imports" / handle / str(job_id)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        src = work / "upload"
        download(storage_path, src)
        paths = takeout_paths(src, work / "files")
    except (RuntimeError, zipfile.BadZipFile, OSError) as e:
        return finish(con, job_id, "failed", f"Couldn't read the file: {e}")
    if not paths:
        return finish(con, job_id, "failed",
                      "No saved lists found in that file. In Google Takeout, choose Maps (your places) > Saved.")

    ok, out = run(["ingest.py", "--user", handle] + paths, log)
    if not ok:
        tail = [l for l in out.strip().splitlines() if l.strip()][-1:] or ["ingest failed"]
        return finish(con, job_id, "failed", f"Import stopped: {tail[0]}")
    # notes, Google matching, profile, picks: a failed later step still leaves the places imported
    failed = []
    for step in (["extract.py", "--user", handle, "--all"], ["enrich.py", "--user", handle],
                 ["profile.py", "--user", handle], ["match.py", "--user", handle, "--ratings", "0"]):
        ok, _ = run(step, log)
        if not ok:
            failed.append(step[0])
    after = counts(con, uid)
    added = after["places"] - before["places"]
    msg = f"Imported {added} new places ({after['food']} food and drink places in all)."
    if failed:
        msg += f" Some steps need another try: {', '.join(failed)}."
    shutil.rmtree(work / "files", ignore_errors=True)  # keep only the upload, for a rerun
    return finish(con, job_id, "done" if not failed else "failed", msg, {"before": before, "after": after})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    con = connect()
    ensure_schema(con)
    if not con.execute("SELECT to_regclass('public.import_jobs')").fetchone()[0]:
        raise SystemExit("The import_jobs table is missing. Run: bash deploy.sh")
    logs = ROOT / "data" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    with (logs / f"imports-{datetime.date.today():%Y-%m-%d}.log").open("a") as log:
        while True:
            job = claim(con)
            if not job:
                break
            try:
                do_job(con, job, log)
            except Exception as e:  # never leave a job stuck as running
                con.rollback()
                finish(con, job[0], "failed", f"Unexpected error: {e}")
                log.write(f"job {job[0]} error: {e!r}\n")
            if args.once:
                break
    con.close()


if __name__ == "__main__":
    main()
