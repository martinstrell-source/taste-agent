#!/bin/bash
# Deploys Supabase changes from this folder: new schema files first, then the Edge Functions.
#   ./deploy.sh              schema changes and both functions
#   ./deploy.sh functions    functions only
#   ./deploy.sh schema       schema changes only
# Schema changes live in supabase/migrations (from schema v9 on; v1-v8 were run by hand). The CLI records
# each one it runs in the database and never runs one twice. It lists them and asks before running.
# Needs, once: npx supabase login  (uses the Supabase CLI through npm; a Homebrew install works too)
set -euo pipefail
cd "$(dirname "$0")"

# the CLI: an installed copy if there is one, otherwise through npx (Node is already here for the app)
if command -v supabase >/dev/null; then SB=(supabase); else SB=(npx -y supabase); fi
[ -f .env ] || { echo "No .env here"; exit 1; }

val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
DB_URL=$(val SUPABASE_DB_URL)
REF=$(val SUPABASE_URL | sed -E 's#https://([^.]+)\.supabase\.co.*#\1#')
[ -n "$DB_URL" ] || { echo "SUPABASE_DB_URL missing from .env"; exit 1; }
[ -n "$REF" ] || { echo "SUPABASE_URL missing from .env"; exit 1; }

what=${1:-all}

if [ "$what" = all ] || [ "$what" = schema ]; then
  echo "== Schema changes"
  "${SB[@]}" db push --db-url "$DB_URL"
fi

if [ "$what" = all ] || [ "$what" = functions ]; then
  for fn in capture place-details; do
    echo "== Function: $fn"
    "${SB[@]}" functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-api
  done
fi

echo "== Done"
