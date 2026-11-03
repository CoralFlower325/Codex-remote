import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { terminalCwdIntegration, terminalReportedCwd } from './terminal-cwd.js';

describe('terminal shell directory integration', () => {
  it('decodes filesystem reports without confusing Windows drives or escaped path characters', () => {
    expect(terminalReportedCwd('file:///F:/work/space%20%23%20%E6%96%87%E6%A1%A3', 'win32'))
      .toBe('F:\\work\\space # \u6587\u6863');
    expect(terminalReportedCwd('file:///Users/example/work', 'darwin')).toBe('/Users/example/work');
    for (const invalid of ['', 'https://example.test/a', 'file:///tmp/a?b', 'file:///tmp/a#b', 'file:///tmp/%00']) {
      expect(terminalReportedCwd(invalid, 'linux')).toBeNull();
    }
  });

  it('retains PowerShell profiles and installs a prompt hook without changing files on disk', () => {
    const integration = terminalCwdIntegration('powershell.exe', ['-NoLogo']);
    expect(integration.supported).toBe(true);
    expect(integration.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    const script = Buffer.from(integration.args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('$function:prompt');
    expect(script).toContain("Provider.Name -eq 'FileSystem'");
    expect(script).toContain('LASTEXITCODE = $remoteExit');
    integration.dispose();
  });

  it('isolates zsh startup files and removes only its temporary integration directory', () => {
    const integration = terminalCwdIntegration('/bin/zsh', ['-l'], { HOME: '/Users/example', ZDOTDIR: '/custom' });
    const directory = integration.env.ZDOTDIR!;
    try {
      expect(integration.env.REMOTE_USER_ZDOTDIR).toBe('/custom');
      expect(integration.args).toEqual(['-l']);
      expect(fs.readFileSync(path.join(directory, '.zshrc'), 'utf8')).toContain('add-zsh-hook precmd');
      expect(fs.readFileSync(path.join(directory, '.zlogin'), 'utf8')).toContain('source "$ZDOTDIR/.zlogin"');
    } finally { integration.dispose(); }
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('keeps bash login startup arguments and any inherited prompt command', () => {
    const integration = terminalCwdIntegration('/bin/bash', ['-l'], { PROMPT_COMMAND: 'custom_prompt' });
    try {
      expect(integration.args).toEqual(['-l']);
      expect(integration.env.PROMPT_COMMAND).toContain('custom_prompt; ');
      expect(integration.env.PROMPT_COMMAND).toContain('__remote_report_cwd');
      expect(fs.readFileSync(integration.env.REMOTE_BASH_CWD!, 'utf8')).not.toContain('/etc/profile');
    } finally { integration.dispose(); }
  });

  it('does not pretend to track unsupported shells', () => {
    expect(terminalCwdIntegration('/bin/fish', ['-l']).supported).toBe(false);
  });
});
