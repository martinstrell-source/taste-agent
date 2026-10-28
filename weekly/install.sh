#!/bin/bash
# Install (or reinstall) the weekly run on this Mac. Run from anywhere:
#   bash ~/Claude/Projects/taste-agent/weekly/install.sh
# To remove it:  launchctl bootout gui/$(id -u)/com.tasteagent.weekly
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.tasteagent.weekly.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"
sed "s#__ROOT__#$ROOT#g" "$ROOT/weekly/com.tasteagent.weekly.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/com.tasteagent.weekly" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed: runs Mondays at 6:30 AM. Logs: $ROOT/data/logs/"
echo "Run it once now with:  launchctl kickstart gui/$(id -u)/com.tasteagent.weekly"
