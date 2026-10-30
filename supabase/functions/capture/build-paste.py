#!/usr/bin/env python3
# Builds paste-into-dashboard.ts (one file for the Supabase dashboard editor) from index.ts + core.ts + discover.ts + onboard.ts + search.ts + starter.ts.
# Run from anywhere: python3 supabase/functions/capture/build-paste.py
import pathlib, re

here = pathlib.Path(__file__).parent

def body(name, renames=()):
    s = (here / name).read_text()
    s = re.sub(r"^import [^;]*? from '\./[^']+';\n", "", s, flags=re.M | re.S)  # local imports: everything is in one file
    for a, b in renames:
        s = re.sub(rf"\b{a}\b", b, s)
    return s

out = (
    "// ONE-FILE VERSION for pasting into the Supabase dashboard editor (Edge Functions > capture > Code).\n"
    "// Generated from index.ts + core.ts + discover.ts + onboard.ts + search.ts + starter.ts by build-paste.py; edit those, not this.\n\n"
    + body("index.ts")
    + "\n// ---------- core.ts ----------\n\n" + body("core.ts")
    + "\n// ---------- discover.ts ----------\n\n" + body("discover.ts", [("FOOD", "FOOD_D"), ("Place", "DPlace")])
    + "\n// ---------- onboard.ts ----------\n\n" + body("onboard.ts")
    + "\n// ---------- search.ts ----------\n\n" + body("search.ts")
    + "\n// ---------- starter.ts ----------\n\n" + body("starter.ts", [("Place", "SPlace")])
)
(here / "paste-into-dashboard.ts").write_text(out)
print(f"wrote paste-into-dashboard.ts ({len(out)} chars)")
