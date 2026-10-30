#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$1"
LABEL="com.codex.remote"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALLED=false; RUNNING=false; ENABLED=false; CONFLICT=false
if [[ -f "$PLIST" ]]; then
  INSTALLED=true
  OWNER="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")"
  if [[ "$OWNER" != "$ROOT_DIR" ]]; then CONFLICT=true; fi
fi
if [[ "$CONFLICT" == false ]]; then
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then RUNNING=true; fi
  if [[ "$INSTALLED" == true ]] &&
    ! launchctl print-disabled "$DOMAIN" | grep -q "\"$LABEL\" => true"; then ENABLED=true; fi
fi
printf '{"installed":%s,"running":%s,"enabled":%s,"conflict":%s,"tunnelManaged":false}\n' \
  "$INSTALLED" "$RUNNING" "$ENABLED" "$CONFLICT"
