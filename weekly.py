#!/usr/bin/env python3
"""The weekly pipeline run, start to finish. Scheduled on the Mac mini by launchd (see weekly/).

1. fetch_sources.py   new articles and newsletters (shared)
2. discover.py        Google and web search for new places (shared)
3. for each user: profile.py, then match.py

Each step's output goes to data/logs/weekly-<date>.log. A failed step is noted and the run carries
on (a newsletter problem shouldn't stop the picks). At the end a Mac notification says how it went.

  python weekly.py              # everything
  python weekly.py --skip-web   # discovery without the Claude web search (no cost beyond Google's free tier)
  python weekly.py --dry-run    # print the steps, run nothing
"""
import argparse
import datetime
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = sys.executable  # the .venv python that runs this script


def notify(title, text):
    """A macOS notification; quietly skipped anywhere else."""
    try:
        subprocess.run(["osascript", "-e", f'display notification "{text}" with title "{title}"'],
                       check=False, timeout=10, capture_output=True)
    except (OSError, subprocess.SubprocessError):
        pass


def users():
    sys.path.insert(0, str(ROOT))
    from common import connect, ensure_schema
    con = connect()
    ensure_schema(con)
    rows = con.execute("SELECT handle FROM app_users ORDER BY handle").fetchall()
    con.close()
    return [r[0] for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-web", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    logs = ROOT / "data" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"weekly-{datetime.date.today().isoformat()}.log"

    steps = [["fetch_sources.py"], ["discover.py"] + (["--skip-web"] if args.skip_web else [])]
    try:
        handles = users()
    except SystemExit as e:  # e.g. a schema file not run yet
        notify("Taste Agent weekly run", "Could not start: see the log")
        log_path.write_text(f"Could not read users: {e}\n")
        raise
    for h in handles:
        steps += [["profile.py", "--user", h], ["match.py", "--user", h]]

    if args.dry_run:
        for s in steps:
            print(" ".join(s))
        return

    failed = []
    started = time.time()
    with log_path.open("a") as log:
        log.write(f"=== weekly run {datetime.datetime.now():%Y-%m-%d %H:%M} ({len(handles)} users)\n")
        for s in steps:
            label = " ".join(s)
            log.write(f"\n--- {label}\n")
            log.flush()
            t = time.time()
            try:
                r = subprocess.run([PY, str(ROOT / s[0])] + s[1:], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                   timeout=60 * 60)
                ok = r.returncode == 0
            except subprocess.TimeoutExpired:
                ok = False
                log.write("(stopped after an hour)\n")
            log.write(f"--- {label}: {'ok' if ok else 'FAILED'} in {time.time() - t:.0f}s\n")
            log.flush()
            if not ok:
                failed.append(label)
        minutes = (time.time() - started) / 60
        log.write(f"\n=== done in {minutes:.0f} min; failed: {', '.join(failed) or 'none'}\n")

    if failed:
        notify("Taste Agent weekly run", f"{len(failed)} step(s) failed: {', '.join(failed)[:120]}. See {log_path.name}")
    else:
        notify("Taste Agent weekly run", f"Done in {minutes:.0f} min. New picks are ready.")
    print(f"log: {log_path}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
