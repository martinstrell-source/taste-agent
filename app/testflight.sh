#!/bin/bash
# Builds the iPhone app in Expo's cloud and sends it to TestFlight.
#   bash testflight.sh
# The first run asks a few questions (Expo login, creating the Expo project, your Apple ID and password,
# creating the signing certificates). Later runs only ask for the Apple ID if its session has expired.
set -euo pipefail
cd "$(dirname "$0")"
export EAS_NO_VCS=1 # this folder is not a git repo; upload it as is (minus .easignore)
EAS=(npx -y eas-cli@latest)

[ -f .env ] || { echo "app/.env is missing (Supabase URL and publishable key)"; exit 1; }

echo "== Expo account"
"${EAS[@]}" whoami >/dev/null 2>&1 || "${EAS[@]}" login

if ! grep -q '"projectId"' app.json; then
  echo "== Creating the Expo project (adds its id to app.json)"
  "${EAS[@]}" init
fi

echo "== Building in Expo's cloud, then uploading to App Store Connect"
"${EAS[@]}" build --platform ios --profile production --auto-submit
