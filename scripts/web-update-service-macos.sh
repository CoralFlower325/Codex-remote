#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$1" && pwd)"
ACTION="$2"
SERVICE="gui/$(id -u)/com.codex.remote"
PLIST="$HOME/Library/LaunchAgents/com.codex.remote.plist"
INSTALLED=false; CONFLICT=false; RUNNING=false; ENABLED=false; PID=""
if [[ -f "$PLIST" ]]; then
  INSTALLED=true
  OWNER="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")"
  [[ "$OWNER" != "$ROOT" ]] && CONFLICT=true
fi
if [[ "$INSTALLED" == true && "$CONFLICT" == false ]]; then
  if ! launchctl print-disabled "gui/$(id -u)" | grep -q '"com.codex.remote" => true'; then ENABLED=true; fi
  STATUS="$(launchctl print "$SERVICE" 2>/dev/null || true)"
  PID="$(printf '%s' "$STATUS" | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p')"
  [[ -n "$PID" ]] && RUNNING=true
fi
if [[ "$ACTION" == "Status" ]]; then
  printf '{"installed":%s,"conflict":%s,"running":%s,"enabled":%s,"pids":[%s]}\n' \
    "$INSTALLED" "$CONFLICT" "$RUNNING" "$ENABLED" "$PID"
  exit 0
fi
if [[ "$INSTALLED" != true || "$CONFLICT" == true ]]; then
  echo "Remote service is absent or belongs to another installation." >&2
  exit 1
fi
case "$ACTION" in
  Stop)
    launchctl disable "$SERVICE"
    if [[ "$RUNNING" == true ]]; then launchctl bootout "$SERVICE"; fi
    ;;
  Start)
    [[ "$RUNNING" == false ]] || { echo "Old backend has not exited." >&2; exit 1; }
    launchctl enable "$SERVICE"
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ;;
  *) exit 2 ;;
esac
