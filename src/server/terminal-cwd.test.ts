import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

  for (const shell of ['bash', 'zsh']) {
    it.skipIf(process.platform === 'win32' || !fs.existsSync(`/bin/${shell}`))(
      `reports UTF-8 path bytes in ${shell} without leaking locale or shell options`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-encoding-'));
        const cwd = path.join(directory, 'space # \u6587\u6863 % \u00e9');
        fs.mkdirSync(cwd);
        const integration = terminalCwdIntegration(`/bin/${shell}`, [], { HOME: directory });
        try {
          const script = shell === 'zsh'
            ? 'source "$REMOTE_SHELL_ZDOTDIR/.zshrc"; setopt multibyte; before=$options[multibyte]; __remote_report_cwd; [[ "$options[multibyte]" = "$before" ]]'
            : 'source "$REMOTE_BASH_CWD"; __remote_report_cwd';
          const result = spawnSync(`/bin/${shell}`, ['-f', '-c', script], {
            cwd, encoding: 'utf8',
            env: { ...process.env, HOME: directory, LC_ALL: 'C', ...integration.env },
            timeout: 5000
          });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          const report = /\x1b\]7;([^\x07]*)\x07/.exec(result.stdout)?.[1];
          expect(report, result.stdout).toContain('%E6%96%87%E6%A1%A3');
          const reported = terminalReportedCwd(report ?? '');
          expect(reported).not.toBeNull();
          expect(fs.realpathSync.native(reported!)).toBe(fs.realpathSync.native(cwd));
        } finally {
          integration.dispose();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    );
  }
});
