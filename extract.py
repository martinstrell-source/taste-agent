"""extract.py: Claude reads each saved-place note and pulls out structured fields.

Writes to table `note_extractions` in Supabase. Does not modify `places`.

Personal shorthand (e.g. "J" = a friend named Jordan) comes from the user_shorthand table, not code.

  python extract.py --user martin --sample 30        # random 30 new notes, stores results, writes a review CSV
  python extract.py --user martin --sample 30 --redo # same 30 again (same seed), overwriting stored results
  python extract.py --user martin --sample 30 --redo --no-store --model claude-haiku-5-5   # comparison, CSV only
  python extract.py --user martin --all              # every note not yet extracted
  python extract.py --user martin --fix-aliases      # re-apply shorthand to stored rows, no API calls
"""
import argparse, csv, os, random, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

from common import connect, ensure_schema, get_user, jsonb, load_env

ROOT = Path(__file__).parent
DEFAULT_MODEL = "claude-sonnet-5-5"

# General canonical names (apply to every user). Personal shorthand lives in user_shorthand.
GENERAL_ALIASES = {("app", "Google recommendation"): ("app", "Google")}


def user_aliases(user):
    """Map a user's shorthand terms to canonical sources, e.g. ('person','J') -> ('person','Jordan')."""
    out = dict(GENERAL_ALIASES)
    for sh in user["shorthand"]:
        out[(sh["type"], sh["term"])] = (sh["type"], sh["name"])
    return out


def known_sources_text(user):
    if not user["shorthand"]:
        return "(none recorded for this user)"
    return "\n".join(f'- "{sh["term"]}" = {sh["description"] or sh["name"]} ({sh["type"]}, name "{sh["name"]}")'
                     for sh in user["shorthand"])


def canon(sources, aliases):
    out = []
    for s in sources:
        t, n = aliases.get((s["type"], s["name"]), (s["type"], s["name"]))
        if {"type": t, "name": n} not in out:
            out.append({"type": t, "name": n})
    return out


def fix_aliases(con, user):
    """Re-apply the user's aliases to rows already stored. No API calls."""
    aliases = user_aliases(user)
    changed = 0
    for pid, old in con.execute("SELECT place_key, sources FROM note_extractions WHERE user_id=%s",
                                (user["uid"],)).fetchall():
        old = old or []
        new = canon(old, aliases)
        if new != old:
            first = new[0] if new else {"type": "none", "name": ""}
            con.execute("UPDATE note_extractions SET sources=%s, source_type=%s, source_name=%s "
                        "WHERE user_id=%s AND place_key=%s",
                        (jsonb(new), first["type"], first["name"], user["uid"], pid))
            changed += 1
    con.commit()
    print(f"aliases applied, {changed} rows updated")


SYSTEM_TEMPLATE = """You read one entry from a person's Google Maps "Want to go" list: the place name and the short note they left when saving it. Notes are terse and personal. Some are a full review pasted from a food community post.

Extract what the note says. Do not invent anything the note does not support.

Field guidance:
- dishes: specific foods or drinks named, including coffee beans, teas and drinks. Keep the qualifiers the note gives ("NY style pizza", not "pizza"; "Glitch beans", not "coffee"). Empty list if none.
- sources: every source the note mentions, in the order given. A note can have more than one ("Sam says go, also on the Eater heatmap" has two). Empty list if none. Each source has a type and a name.
  type is one of:
  publication = newspaper, magazine, guide or critic (SF Chronicle, Eater, NYT, Michelin, Infatuation, Mercury News)
  person = someone the saver personally knows, named or described ("Sam", "coworker Priya", "Ana and Lee")
  community = online forum or group (Reddit, Yelp, a Facebook group)
  creator = individual social media creator or video (TikTok, Instagram reel, YouTube, Bluesky)
  public_figure = a celebrity or historical figure the saver does not know (a band, an author, a chef on TV)
  app = an app's suggestion ("Google recommendation")
  A pasted long review is usually from a community post; use community unless the text names another source.
  name: a short clean canonical name. Normalize variants: "SF Eater", "Eater SF" -> "Eater"; "SF Chron", "Chronicle" -> "SF Chronicle"; "Merc" -> "Mercury News"; "New York Times" -> "NYT".
- intent: dish = saved mainly for a specific item; place = saved for the place overall; not_food = not a food or drink destination; unclear.
- kind: restaurant, bakery, cafe, dessert, bar, market, food_truck, not_food, unknown.
- cuisine: short label if clear (e.g. "japanese", "persian", "mexican"), else empty.
- sentiment: neutral by default. Use positive only when the note itself expresses enthusiasm or a ranking ("loved it", "best", "must order", "good"). A bare source name ("Eater", "Reddit") is neutral. negative = the note is critical. near_miss = almost went or chose somewhere else.
- constraints: practical notes like hours or days ("Saturday only"). Empty list if none.
- reason: one plain line, under 15 words, on why this was saved.

Known shorthand for this user:
{known}

Always respond by calling the record tool exactly once. No other text."""

SOURCE_TYPES = ["publication", "person", "community", "creator", "public_figure", "app"]
TOOL = {
    "name": "record",
    "description": "Record the extracted fields for this saved place.",
    "input_schema": {
        "type": "object",
        "properties": {
            "dishes": {"type": "array", "items": {"type": "string"}},
            "sources": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": SOURCE_TYPES},
                        "name": {"type": "string"},
                    },
                    "required": ["type", "name"],
                },
            },
            "intent": {"type": "string", "enum": ["dish", "place", "not_food", "unclear"]},
            "kind": {"type": "string", "enum": ["restaurant", "bakery", "cafe", "dessert", "bar", "market", "food_truck", "not_food", "unknown"]},
            "cuisine": {"type": "string"},
            "sentiment": {"type": "string", "enum": ["positive", "neutral", "negative", "near_miss"]},
            "constraints": {"type": "array", "items": {"type": "string"}},
            "reason": {"type": "string"},
        },
        "required": ["dishes", "sources", "intent", "kind", "cuisine", "sentiment", "constraints", "reason"],
    },
}

def extract_one(client, model, system, title, note):
    for attempt in range(4):
        try:
            r = client.messages.create(
                model=model,
                max_tokens=800,
                system=system,
                tools=[TOOL],
                tool_choice={"type": "auto"},
                messages=[{"role": "user", "content": f"Place: {title}\nNote: {note}"}],
            )
            block = next((b for b in r.content if b.type == "tool_use"), None)
            if block is not None:
                return block.input, r.usage
            # model answered in text instead of calling the tool; try again
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after retries: {title}")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--sample", type=int)
    g.add_argument("--all", action="store_true")
    g.add_argument("--fix-aliases", action="store_true", help="apply the user's shorthand to stored rows, no API calls")
    ap.add_argument("--user", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--redo", action="store_true", help="include notes already extracted")
    ap.add_argument("--no-store", action="store_true", help="write the review CSV only, leave the database alone")
    args = ap.parse_args()

    con = connect()
    ensure_schema(con)
    user = get_user(con, args.user)
    aliases = user_aliases(user)
    if args.fix_aliases:
        fix_aliases(con, user)
        return

    load_env()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set (put it in .env)")

    system = SYSTEM_TEMPLATE.replace("{known}", known_sources_text(user))
    q = ("SELECT p.place_key, p.title, p.note FROM places p "
         "WHERE p.user_id = %s AND p.removed_at IS NULL AND trim(coalesce(p.note,'')) <> ''")
    if not args.redo:
        q += (" AND NOT EXISTS (SELECT 1 FROM note_extractions e "
              "WHERE e.user_id = p.user_id AND e.place_key = p.place_key)")
    rows = con.execute(q + " ORDER BY p.id", (user["uid"],)).fetchall()
    if args.sample:
        random.Random(args.seed).shuffle(rows)
        rows = rows[: args.sample]
    print(f"extracting {len(rows)} notes with {args.model}" + (" (not stored)" if args.no_store else ""))

    client = anthropic.Anthropic()
    results, tin, tout = [], 0, 0

    def work(row):
        return row, *extract_one(client, args.model, system, row[1], row[2])

    with ThreadPoolExecutor(max_workers=5) as ex:
        for (pid, title, note), d, usage in ex.map(work, rows):
            tin += usage.input_tokens; tout += usage.output_tokens
            srcs = canon(d.get("sources") or [], aliases)
            first = srcs[0] if srcs else {"type": "none", "name": ""}
            if not args.no_store:
                con.execute(
                    """INSERT INTO note_extractions
                       (user_id, place_key, model, dishes, source_type, source_name, intent, kind, cuisine,
                        sentiment, constraints, reason, input_tokens, output_tokens, extracted_at, sources)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s)
                       ON CONFLICT (user_id, place_key) DO UPDATE SET
                         model=excluded.model, dishes=excluded.dishes, source_type=excluded.source_type,
                         source_name=excluded.source_name, intent=excluded.intent, kind=excluded.kind,
                         cuisine=excluded.cuisine, sentiment=excluded.sentiment, constraints=excluded.constraints,
                         reason=excluded.reason, input_tokens=excluded.input_tokens,
                         output_tokens=excluded.output_tokens, extracted_at=excluded.extracted_at,
                         sources=excluded.sources""",
                    (user["uid"], pid, args.model, jsonb(d["dishes"]), first["type"], first["name"], d["intent"],
                     d["kind"], d["cuisine"] or None, d["sentiment"], jsonb(d["constraints"]), d["reason"],
                     usage.input_tokens, usage.output_tokens, jsonb(srcs)),
                )
                con.commit()
            results.append((title, note, d))

    if args.sample:
        out = ROOT / "data" / f"extract_sample_{args.user}_{args.model}.csv"
        with out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["place", "note", "dishes", "sources", "intent", "kind", "cuisine", "sentiment",
                        "constraints", "reason"])
            for title, note, d in results:
                srcs = "; ".join(f'{s["type"]}:{s["name"]}' for s in d.get("sources") or [])
                w.writerow([title, note, "; ".join(d["dishes"]), srcs, d["intent"], d["kind"], d["cuisine"],
                            d["sentiment"], "; ".join(d["constraints"]), d["reason"]])
        print(f"wrote {out}")
    print(f"tokens: {tin} in, {tout} out")


if __name__ == "__main__":
    main()
