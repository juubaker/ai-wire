#!/bin/bash
#
# One scheduled check, wrapped for launchd.
#
# launchd runs jobs with almost no environment: no PATH beyond /usr/bin:/bin,
# no shell profile, no nvm. A script that works in your terminal and fails
# under launchd is almost always this. So everything here is absolute, and the
# node path is baked in at install time by install-cron.sh.
#
# Run it by hand first — it behaves identically either way:
#   ./scripts/check-cron.sh
#
# Opt in to deploying by setting WIRE_PUSH=1 (see install-cron.sh --push).
# Without it the check only writes public/feed.json locally.

set -uo pipefail

REPO="/Users/johnbaker/Projects/ai-wire"
NODE="/opt/homebrew/bin/node"
LOG="$HOME/Library/Logs/ai-wire-check.log"
MAX_LOG_LINES=2000

mkdir -p "$(dirname "$LOG")"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# Keep the log from growing without bound. Trimmed before the run so a failure
# leaves its output intact at the end of the file.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt "$MAX_LOG_LINES" ]; then
  tail -n $((MAX_LOG_LINES / 2)) "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

cd "$REPO" || { log "FATAL: repo not found at $REPO"; exit 1; }

if [ ! -x "$NODE" ]; then
  log "FATAL: node not executable at $NODE — re-run scripts/install-cron.sh"
  exit 1
fi

# Ollama has to be up. Without this the failure surfaces as a confusing
# "could not reach" deep in the check; here it is one line and obvious.
if ! curl -sf -m 5 "${OLLAMA_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
  log "skipped: Ollama is not responding at ${OLLAMA_BASE_URL:-http://localhost:11434}"
  exit 0
fi

log "--- check starting ---"
out="$("$NODE" scripts/check.mjs 2>&1)"
status=$?
printf '%s\n' "$out" >>"$LOG"

added="$(printf '%s' "$out" | grep -o 'added=[0-9]*' | head -1 | cut -d= -f2)"
added="${added:-0}"

if [ "$status" -ne 0 ]; then
  log "--- check FAILED (exit $status) ---"
  exit "$status"
fi

log "--- check done, added=$added ---"

# Deploying is opt-in. A scheduled job that commits and pushes on its own is a
# reasonable thing to want and a surprising thing to discover, so it only
# happens when you asked for it.
if [ "${WIRE_PUSH:-0}" = "1" ] && [ "$added" -gt 0 ]; then
  if git diff --quiet -- public/feed.json; then
    log "push: feed.json unchanged, nothing to commit"
  else
    git add public/feed.json >>"$LOG" 2>&1
    git commit -m "feed: $added new $([ "$added" = 1 ] && echo entry || echo entries)" >>"$LOG" 2>&1
    if git push >>"$LOG" 2>&1; then
      log "push: deployed $added new"
    else
      log "push: FAILED — commit is local, push by hand"
    fi
  fi
fi
