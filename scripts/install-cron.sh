#!/bin/bash
#
# Install the hourly check as a macOS launchd agent.
#
#   ./scripts/install-cron.sh              # check hourly, write feed.json locally
#   ./scripts/install-cron.sh --push       # also commit and push, so the site updates
#   ./scripts/install-cron.sh --uninstall  # remove it
#
# launchd rather than crontab: cron is deprecated on macOS, and launchd runs a
# job it missed once the machine wakes, which matters for a laptop that spends
# nights closed. A missed hour is caught up rather than skipped silently.

set -euo pipefail

LABEL="com.johnbaker.aiwire.check"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO/scripts/check-cron.sh"
INTERVAL=3600

unload() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    launchctl unload "$PLIST" 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  unload
  rm -f "$PLIST" "$REPO/scripts/.check-cron.local.sh"
  echo "removed: $LABEL"
  exit 0
fi

PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

# Resolve node now, while a login shell's PATH is available. launchd will not
# have it later — this is the single most common reason a scheduled job that
# works in a terminal does nothing on a schedule.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found on PATH. Install it or run this from a shell where 'node' works." >&2
  exit 1
fi
echo "node:     $NODE ($("$NODE" --version))"
echo "repo:     $REPO"
echo "interval: ${INTERVAL}s ($((INTERVAL / 60)) min)"
echo "push:     $([ "$PUSH" = 1 ] && echo "yes — commits and pushes feed.json" || echo "no — writes feed.json locally only")"

# Bake the absolute paths into a generated copy, leaving the template in git.
RUNNER="$REPO/scripts/.check-cron.local.sh"
sed -e "s|__REPO__|$REPO|" -e "s|__NODE__|$NODE|" "$WRAPPER" >"$RUNNER"
chmod +x "$RUNNER"

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WIRE_PUSH</key><string>$PUSH</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE")</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <!-- false on purpose: logging in should not spend 15 search requests. -->
  <key>RunAtLoad</key><false/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ai-wire-launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ai-wire-launchd.log</string>
</dict>
</plist>
PLIST_EOF

unload
launchctl load "$PLIST"

echo
echo "installed. first run within the hour."
echo
echo "  run now:    launchctl start $LABEL"
echo "  watch log:  tail -f ~/Library/Logs/ai-wire-check.log"
echo "  is it on:   launchctl list | grep aiwire"
echo "  remove:     ./scripts/install-cron.sh --uninstall"
