import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const powershell = `
$global:__RemoteOriginalPrompt = $function:prompt
function global:prompt {
  $remoteExit = $global:LASTEXITCODE
  $remotePrompt = & $global:__RemoteOriginalPrompt
  try {
    $remoteLocation = Get-Location
    $remoteUri = ''
    if ($remoteLocation.Provider.Name -eq 'FileSystem') {
      $remoteUri = ([System.Uri]::new($remoteLocation.ProviderPath)).AbsoluteUri
    }
    [Console]::Write(([char]27) + ']7;' + $remoteUri + [char]7)
  } catch { [Console]::Write(([char]27) + ']7;' + [char]7) }
  $global:LASTEXITCODE = $remoteExit
  $remotePrompt
}
`;

// Encode path bytes rather than assuming that shell paths are safe URI text.
const reportPosix = `
__remote_report_cwd() {
  local remote_exit=$? value="$PWD" encoded="" char hex i
  if [ -n "\${ZSH_VERSION-}" ]; then
    emulate -L zsh
    setopt no_multibyte
  fi
  local LC_ALL=C
  for ((i=0; i<\${#value}; i++)); do
    char="\${value:$i:1}"
    case "$char" in
      [a-zA-Z0-9/._~-]) encoded="$encoded$char" ;;
      *)
        printf -v hex '%d' "'$char"
        printf -v hex '%%%02X' "$((hex & 255))"
        encoded="$encoded$hex" ;;
    esac
  done
  printf '\\033]7;file://%s\\007' "$encoded"
  return "$remote_exit"
}
`;

export interface TerminalCwdIntegration {
  args: string[];
  env: Record<string, string>;
  supported: boolean;
  dispose: () => void;
}

export function terminalCwdIntegration(file: string, args: string[], env = process.env): TerminalCwdIntegration {
  const name = path.basename(file).replace(/\.exe$/i, '').toLowerCase();
  const unchanged = { args, env: {}, supported: false, dispose: () => {} };
  if (['pwsh', 'powershell'].includes(name)) return {
    ...unchanged, supported: true,
    args: [...args, '-NoExit', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')]
  };
  if (!['bash', 'zsh'].includes(name)) return unchanged;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-shell-'));
  fs.chmodSync(directory, 0o700);
  const write = (name: string, text: string) => fs.writeFileSync(path.join(directory, name), text, { mode: 0o600 });
  // The PTY may still be unlinking its rc files when close returns on macOS.
  const dispose = () => fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 25
  });
  try {
    if (name === 'bash') {
      write('cwd.bash', reportPosix);
      const report = 'if ! declare -F __remote_report_cwd >/dev/null; then source "$REMOTE_BASH_CWD"; fi; __remote_report_cwd';
      return { args, supported: true, dispose, env: {
        REMOTE_BASH_CWD: path.join(directory, 'cwd.bash'),
        PROMPT_COMMAND: `${env.PROMPT_COMMAND ? env.PROMPT_COMMAND + '; ' : ''}${report}`
      } };
    }
    // Keep the user's login files and prompts; only this shell gets a temporary ZDOTDIR.
    for (const startup of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      write(startup, `
ZDOTDIR="$REMOTE_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/${startup}" ]] && source "$ZDOTDIR/${startup}"
REMOTE_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
${startup === '.zshrc' ? `${reportPosix}
autoload -Uz add-zsh-hook
__remote_zsh_cwd() { __remote_report_cwd; return 0; }
add-zsh-hook precmd __remote_zsh_cwd
add-zsh-hook chpwd __remote_zsh_cwd
` : ''}
${startup === '.zlogin' ? '' : 'ZDOTDIR="$REMOTE_SHELL_ZDOTDIR"'}
`);
    }
    return { args, supported: true, dispose, env: {
      REMOTE_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || os.homedir(),
      REMOTE_SHELL_ZDOTDIR: directory, ZDOTDIR: directory
    } };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function terminalReportedCwd(value: string, platform = process.platform): string | null {
  if (!value || value.length > 32_768) return null;
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:' || uri.search || uri.hash) return null;
    const result = fileURLToPath(uri, { windows: platform === 'win32' });
    return /[\x00-\x1f\x7f]/.test(result) ? null : result;
  } catch { return null; }
}
