#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
for script in scripts/*.sh desktop/*.sh ./*.command; do
  bash -n "$script"
done
[[ -x "./Start Remote.command" && -x "./Stop Remote.command" ]]

TEST_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME"' EXIT
export HOME="$TEST_HOME"
export DOTENV_CONFIG_PATH="$TEST_HOME/service.env"
export LAUNCHCTL_TEST_STATE="$TEST_HOME/agent-running"
export LAUNCHCTL_TEST_LOG="$TEST_HOME/agent-actions"
node --input-type=module - "$TEST_HOME" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const data = path.join(root, 'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'auth.json'), '{}', 'utf8');
fs.writeFileSync(process.env.DOTENV_CONFIG_PATH, `PORT=4789\nDATA_DIR=${data}\n`, 'utf8');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$LAUNCHCTL_TEST_LOG"
case "$1" in
  print) test -f "$LAUNCHCTL_TEST_STATE" && echo 'state = running' ;;
  print-disabled) echo '{}' ;;
  bootstrap) touch "$LAUNCHCTL_TEST_STATE" ;;
  bootout) rm "$LAUNCHCTL_TEST_STATE" ;;
  enable|disable) ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
[[ "\${!#}" == "http://127.0.0.1:4789/health" ]] || exit 1
printf '%s\\n' '{"codex":"ready","transport":"desktop"}'
`, { mode: 0o755 });
NODE
export PATH="$TEST_HOME/bin:$PATH"

bash scripts/install-service.sh --no-start
PLIST="$TEST_HOME/Library/LaunchAgents/com.codex.remote.plist"
NODE_BIN="$(command -v node)"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")" == "$ROOT_DIR" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST")" == "$NODE_BIN" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST")" == "$ROOT_DIR/dist-server/server/index.js" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$PLIST")" == "$TEST_HOME/runtime/codex-remote.out.log" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:DOTENV_CONFIG_PATH' "$PLIST")" == "$DOTENV_CONFIG_PATH" ]]
bash scripts/remote-control-macos.sh Start --no-browser
bash scripts/remote-control-macos.sh Start --no-browser
[[ "$(grep -c '^bootstrap ' "$LAUNCHCTL_TEST_LOG")" == "1" ]]
bash scripts/remote-control-macos.sh Status
STATUS_JSON="$(bash scripts/remote-control-macos.sh Status --json)"
node -e 'const s=JSON.parse(process.argv[1]);if(!s.installed||!s.running||s.conflict||s.tunnelManaged)process.exit(1)' "$STATUS_JSON"
FALLBACK_JSON="$(bash desktop/status-macos.sh "$ROOT_DIR")"
node -e 'const s=JSON.parse(process.argv[1]);if(!s.installed||!s.running||s.conflict)process.exit(1)' "$FALLBACK_JSON"
bash scripts/remote-control-macos.sh Stop
[[ ! -f "$LAUNCHCTL_TEST_STATE" ]]
STATUS_JSON="$(bash scripts/remote-control-macos.sh Status --json)"
node -e 'if(JSON.parse(process.argv[1]).running)process.exit(1)' "$STATUS_JSON"
FALLBACK_JSON="$(bash desktop/status-macos.sh "$ROOT_DIR")"
node -e 'if(JSON.parse(process.argv[1]).running)process.exit(1)' "$FALLBACK_JSON"
grep -q '^disable ' "$LAUNCHCTL_TEST_LOG"
bash scripts/remote-control-macos.sh Uninstall
[[ ! -f "$PLIST" ]]
echo "macOS shell, native plist, and isolated lifecycle checks passed."
