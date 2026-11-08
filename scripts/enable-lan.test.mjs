import { describe, expect, it } from 'vitest';
import { parse } from 'dotenv';
import path from 'node:path';
import { lanEnvironment, lanFirewallScript, lanOptions } from './enable-lan.mjs';

describe('LAN setup configuration without system mutation', () => {
  it('requires explicit TLS or plaintext consent, including when an old env already enabled HTTP', () => {
    expect(() => lanOptions([])).toThrow('requires TLS');
    expect(() => lanOptions([], { LAN_ALLOW_HTTP: '1' })).toThrow('requires TLS');
    expect(lanOptions(['--allow-http'])).toEqual({ port: 4546, allowHttp: true, cert: '', key: '' });
    expect(lanOptions(['4550', '--cert', 'cert.pem', '--key', 'key.pem']))
      .toEqual({ port: 4550, cert: 'cert.pem', key: 'key.pem', allowHttp: false });
    expect(lanOptions([], { LAN_CERT_FILE: 'cert.pem', LAN_KEY_FILE: 'key.pem' }).allowHttp).toBe(false);
  });

  it('rejects incomplete, invalid and unexpected input before writing or invoking a firewall command', () => {
    for (const args of [
      ['--cert', 'cert.pem'], ['--key', 'key.pem'], ['--cert'], ['--allow-http', '22'],
      ['--allow-http', '65536'], ['--allow-http', '4546', '4547'], ['--oops'], ['4546;Write-Host bad'],
      ['--cert', 'bad\npath', '--key', 'key.pem']
    ]) expect(() => lanOptions(args)).toThrow();
    expect(() => lanFirewallScript('4546;bad')).toThrow('Invalid');
  });

  it('replaces all old LAN security fields while preserving unrelated environment settings', () => {
    const text = '# Preserve comment\nPUBLIC_ORIGIN=https://example.com\nLAN_PORT=4546\nLAN_ALLOW_HTTP=1\n' +
      'export LAN_CERT_FILE=old.pem\n LAN_KEY_FILE=old-key.pem\n';
    const base = path.resolve('test-lan-root');
    const tls = parse(lanEnvironment(text, lanOptions(['4550', '--cert', 'cert.pem', '--key', 'key.pem']), base));
    expect(tls).toMatchObject({ PUBLIC_ORIGIN: 'https://example.com', LAN_PORT: '4550', LAN_ALLOW_HTTP: '0',
      LAN_CERT_FILE: path.resolve(base, 'cert.pem').replaceAll('\\', '/'),
      LAN_KEY_FILE: path.resolve(base, 'key.pem').replaceAll('\\', '/') });
    const http = lanEnvironment(text, lanOptions(['--allow-http']), base);
    expect(http).toContain('# Preserve comment');
    expect(http).not.toContain('LAN_CERT_FILE');
    expect(http).not.toContain('LAN_KEY_FILE');
    expect(parse(http)).toMatchObject({ LAN_PORT: '4546', LAN_ALLOW_HTTP: '1' });
  });

  it('restricts both existing and new Windows firewall rules to Private/Domain and LocalSubnet', () => {
    const command = lanFirewallScript(4550);
    expect(command.match(/-Profile Private,Domain/g)).toHaveLength(2);
    expect(command.match(/-RemoteAddress LocalSubnet/g)).toHaveLength(2);
    expect(command).toContain('Set-NetFirewallPortFilter -Protocol TCP -LocalPort 4550');
    expect(command).not.toContain('-Profile Any');
    expect(command).not.toContain('-Profile Public');
  });
});
