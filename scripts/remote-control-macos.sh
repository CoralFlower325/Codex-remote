#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
LABEL="com.codex.remote"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ACTION="${1:-Start}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "These controls require macOS. Use the .cmd files on Windows." >&2
  exit 1
fi
if [[ "$ACTION" != "Start" && "$ACTION" != "Stop" && "$ACTION" != "Status" && "$ACTION" != "Uninstall" ]] ||
   [[ "${2:-}" != "" && "${2:-}" != "--no-browser" && ! ( "$ACTION" == "Status" && "${2:-}" == "--json" ) ]] || (( $# > 2 )); then
  echo "Usage: bash scripts/remote-control-macos.sh Start|Stop|Status|Uninstall [--no-browser|--json]" >&2
  exit 1
fi
if [[ -f "$PLIST" ]]; then
  OWNER="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")"
  if [[ "$OWNER" != "$ROOT_DIR" ]]; then
    if [[ "$ACTION" == "Status" && "${2:-}" == "--json" ]]; then
      echo '{"installed":true,"running":false,"enabled":false,"conflict":true,"tunnelManaged":false}'
      exit 0
    fi
    echo "The existing Codex Remote service belongs to another checkout: $OWNER" >&2
    exit 1
  fi
fi

case "$ACTION" in
  Status)
    if [[ "${2:-}" == "--json" ]]; then
      INSTALLED=false; RUNNING=false; ENABLED=false
      [[ -f "$PLIST" ]] && INSTALLED=true
      if launchctl print "$SERVICE" 2>/dev/null | grep -q 'state = running'; then RUNNING=true; fi
      if [[ "$INSTALLED" == "true" ]] &&
        ! launchctl print-disabled "$DOMAIN" | grep -q "\"$LABEL\" => true"; then ENABLED=true; fi
      printf '{"installed":%s,"running":%s,"enabled":%s,"conflict":false,"tunnelManaged":false}\n' "$INSTALLED" "$RUNNING" "$ENABLED"
      exit 0
    fi
    if launchctl print "$SERVICE" >/dev/null 2>&1; then
      launchctl print "$SERVICE"
    else
      echo "Codex Remote is OFF."
    fi
    exit 0
    ;;
  Stop|Uninstall)
    if [[ -f "$PLIST" ]]; then
      launchctl disable "$SERVICE"
      if launchctl print "$SERVICE" >/dev/null 2>&1; then
        launchctl bootout "$SERVICE"
      fi
      if [[ "$ACTION" == "Uninstall" ]]; then
        rm "$PLIST"
      fi
    fi
    echo "Codex Remote is OFF. Login startup disabled. Codex Desktop is still running."
    echo "An independently installed reverse proxy or cloudflared service is managed separately."
    exit 0
    ;;
esac

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && -f "$PLIST" ]]; then
  NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST")"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 22.19 or newer was not found. Install Node.js first." >&2
  exit 1
fi
if [[ ! -f dist-server/server/index.js ]]; then
  echo "Build output is missing. Run npm run setup:macos first." >&2
  exit 1
fi

"$NODE_BIN" --input-type=module <<'NODE'
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
if (!fs.existsSync(path.join(process.env.DATA_DIR?.trim() || 'data', 'auth.json'))) {
  console.error('Set an access password first: npm run set-password');
  process.exit(1);
}
NODE

if [[ ! -f "$PLIST" ]]; then
  bash "$ROOT_DIR/scripts/install-service.sh" --no-start
fi
launchctl enable "$SERVICE"
if ! launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi

LOCAL_URL="$(DOTENV_CONFIG_QUIET=true "$NODE_BIN" --input-type=module -e 'import "dotenv/config"; process.stdout.write(`http://127.0.0.1:${process.env.PORT?.trim() || "4545"}`)')"
PUBLIC_URL="$(DOTENV_CONFIG_QUIET=true "$NODE_BIN" --input-type=module -e 'import "dotenv/config"; process.stdout.write(process.env.PUBLIC_ORIGIN?.trim() || "")')"
READY=0
for (( attempt = 0; attempt < 30; attempt++ )); do
  if curl --silent --fail --max-time 1 "$LOCAL_URL/health" > /dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  echo "Codex Remote did not become ready at $LOCAL_URL. Check its data directory logs." >&2
  exit 1
fi
echo "Codex Remote is ON."
curl --silent --fail --max-time 3 "$LOCAL_URL/health"
echo
echo "Open: ${PUBLIC_URL:-$LOCAL_URL}"
if [[ "${2:-}" != "--no-browser" ]]; then
  open "${PUBLIC_URL:-$LOCAL_URL}"
fi
