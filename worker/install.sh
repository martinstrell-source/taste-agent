#!/bin/bash
# Install (or reinstall) the import worker on this Mac. Run from anywhere:
#   bash ~/Claude/Projects/taste-agent/worker/install.sh
# To remove it:  launchctl bootout gui/$(id -u)/com.tasteagent.imports
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.tasteagent.imports.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"
sed "s#__ROOT__#$ROOT#g" "$ROOT/worker/com.tasteagent.imports.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/com.tasteagent.imports" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed: checks for queued imports every 5 minutes. Logs: $ROOT/data/logs/imports-*.log"
