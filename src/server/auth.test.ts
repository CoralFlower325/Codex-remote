import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('password authentication', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-auth-'));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores a hash and verifies only the correct password', async () => {
    const auth = await import('./auth.js');

    await auth.setPassword('correct horse');

    const raw = fs.readFileSync(path.join(tempDir, 'auth.json'), 'utf8');
    expect(raw).not.toContain('correct horse');
    await expect(auth.verifyPassword('correct horse')).resolves.toBe(true);
    await expect(auth.verifyPassword('wrong password')).resolves.toBe(false);
  });

  it('rejects short passwords', async () => {
    const auth = await import('./auth.js');
    await expect(auth.setPassword('123')).rejects.toThrow(/at least 6/i);
  });

  it('verifies signed sessions and rejects tampering', async () => {
    const auth = await import('./auth.js');
    const token = auth.issueSession();

    expect(auth.verifySessionToken(token)?.sid).toBeTruthy();
    expect(auth.verifySessionToken(`${token}x`)).toBeNull();
    expect(auth.verifySessionToken(undefined)).toBeNull();
  });
  it('records browser sessions without retaining cookies, passwords or raw user agents', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword('synthetic password');
    const token = auth.issueSession('Mozilla/5.0 (iPhone) Version/18 Safari/605.1 secret-agent-marker');
    const listed = auth.authenticatedDevices();
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0].name).toBe('iPhone · Safari');
    const metadata = fs.readFileSync(path.join(tempDir, 'authenticated-devices', listed.devices[0].id + '.json'), 'utf8');
    for (const secret of [token, 'synthetic password', 'secret-agent-marker']) expect(metadata).not.toContain(secret);
  });
  it('revokes just the selected device across separate module instances and never revives it', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword('synthetic password');
    const first = auth.issueSession('Windows Chrome/100');
    const second = auth.issueSession('Macintosh Safari/605');
    const device = auth.authenticatedDevices().devices.find(device => device.name.startsWith('Windows'))!;
    vi.resetModules();
    const administrator = await import('./auth.js');
    administrator.revokeDevice(device.id);
    expect(auth.verifySessionToken(first)).toBeNull();
    expect(auth.verifySessionToken(first)).toBeNull();
    expect(auth.verifySessionToken(second)).not.toBeNull();
    expect(administrator.authenticatedDevices().devices.map(device => device.name)).toEqual(['macOS · Safari']);
    expect(() => administrator.revokeDevice('../auth')).toThrow();
  });
  it('invalidates old sessions when changing passwords while allowing a new login', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword('old synthetic password');
    const old = auth.issueSession();
    await auth.setPassword('new synthetic password');
    expect(auth.verifySessionToken(old)).toBeNull();
    expect(auth.authenticatedDevices().devices).toEqual([]);
    expect(auth.verifySessionToken(auth.issueSession())).not.toBeNull();
    expect(await auth.verifyPassword('old synthetic password')).toBe(false);
  });
  it('revokes all devices without changing the password', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword('synthetic password');
    const token = auth.issueSession();
    auth.revokeAllDevices();
    expect(auth.verifySessionToken(token)).toBeNull();
    expect(await auth.verifyPassword('synthetic password')).toBe(true);
  });
  it('admits legacy cookies on first use and can revoke even an unobserved legacy device', async () => {
    const auth = await import('./auth.js');
    auth.issueSession();
    const secret = Buffer.from(fs.readFileSync(path.join(tempDir, 'session-secret'), 'utf8'), 'base64url');
    const legacy = () => {
      const encoded = Buffer.from(JSON.stringify({ sid: crypto.randomBytes(24).toString('base64url'),
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      return encoded + '.' + crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    };
    const observed = legacy();
    const unseen = legacy();
    expect(auth.verifySessionToken(observed, 'iPad Safari/605')).not.toBeNull();
    const record = auth.authenticatedDevices().devices.find(device => device.name === 'iPad · Safari')!;
    auth.revokeDevice(record.id);
    expect(auth.verifySessionToken(observed)).toBeNull();
    // A legacy password record has no generation until the first administrative change.
    await auth.setPassword('synthetic password');
    expect(auth.verifySessionToken(unseen)).toBeNull();
  });
  it('fails closed for missing registry evidence and malformed or corrupt authentication', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword('synthetic password');
    const token = auth.issueSession();
    const device = auth.authenticatedDevices().devices[0];
    fs.rmSync(path.join(tempDir, 'authenticated-devices', device.id + '.json'));
    expect(auth.verifySessionToken(token)).toBeNull();
    expect(auth.readSessionCookie('codex_remote_session=%invalid')).toBeNull();
    expect(auth.verifySessionToken(token + '.extra')).toBeNull();
    fs.writeFileSync(path.join(tempDir, 'auth.json'), '{corrupt');
    expect(auth.verifySessionToken(token)).toBeNull();
  });
  it('logout revokes the server credential rather than just clearing the browser cookie', async () => {
    const auth = await import('./auth.js');
    const token = auth.issueSession();
    auth.revokeSessionCookie(auth.sessionCookie(token, false));
    expect(auth.verifySessionToken(token)).toBeNull();
  });
});
