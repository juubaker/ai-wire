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

# install-cron.sh substitutes these when it generates .check-cron.local.sh.
# Left unsubstituted, this is the template being run straight out of the repo —
# so resolve both from where we are. Without this the header's promise that it
# behaves identically by hand is false, and it fails as "repo not found at
# __REPO__", which reads like a corrupt install rather than a template.
REPO="__REPO__"
NODE="__NODE__"
[ "$REPO" = "__""REPO__" ] && REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$NODE" = "__""NODE__" ] && NODE="$(command -v node || echo /usr/bin/false)"
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
#
# The first version stopped at that one line, and the wire went stale for four
# days behind 19 consecutive skips — each one logged, none of them visible, and
# every exit code saying the run was fine. So: try to fix it, then count it,
# then say so somewhere that isn't a log file nobody tails.
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
SKIPFILE="$HOME/Library/Logs/.ai-wire-skips"

ollama_up() { curl -sf -m 5 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }

# Only worth starting a local server; a remote endpoint being down is not ours
# to fix.
if ! ollama_up && [ "$OLLAMA_URL" = "http://localhost:11434" ] && [ -d /Applications/Ollama.app ]; then
  log "Ollama not responding — starting it"
  open -ga Ollama >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ollama_up && break
    sleep 2
  done
  ollama_up && log "Ollama came up"
fi

if ! ollama_up; then
  n=$(($(cat "$SKIPFILE" 2>/dev/null || echo 0) + 1))
  printf '%s' "$n" >"$SKIPFILE"
  log "skipped: Ollama is not responding at $OLLAMA_URL (consecutive skips: $n)"
  # Loud on the third, then once a day, so a real outage reaches you but a
  # closed lid overnight does not nag.
  if [ "$n" = 3 ] || { [ "$n" -gt 3 ] && [ $((n % 24)) = 0 ]; }; then
    osascript -e "display notification \"Ollama is down — $n checks skipped, the wire is going stale\" with title \"AI Wire\"" >/dev/null 2>&1 || true
  fi
  exit 0
fi

rm -f "$SKIPFILE"

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
elif [ "$added" -gt 0 ]; then
  # WIRE_PUSH comes from the plist, so it is set only when launchd starts the
  # job. Run this wrapper by hand and the entries land in feed.json with no
  # push — and because the wire's newest date has moved on, the next scheduled
  # run finds nothing and has nothing to push either. That looked exactly like
  # a broken scheduler. Say it instead.
  log "push: $added new, but WIRE_PUSH is not set — feed.json is ahead of git, commit by hand"
fi
