import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DeviceSession {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
interface StoredSession extends DeviceSession { generation: string; }
const identifier = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');
const directory = (dataDir: string) => path.join(dataDir, 'authenticated-devices');

function deviceName(agent = ''): string {
  const text = agent.slice(0, 1024);
  const browser = /Edg\//.test(text) ? 'Edge' : /Firefox\//.test(text) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : '浏览器';
  const system = /iPad/.test(text) ? 'iPad' : /iPhone/.test(text) ? 'iPhone'
    : /Android/.test(text) ? 'Android' : /Windows/.test(text) ? 'Windows'
      : /Macintosh|Mac OS X/.test(text) ? 'macOS' : /Linux/.test(text) ? 'Linux' : '';
  return system ? `${system} · ${browser}` : '未识别设备';
}

export function registerSession(dataDir: string, sid: string, iat: number, exp: number,
  generation: string, agent?: string): void {
  const folder = directory(dataDir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const record: StoredSession = { id: identifier(sid), name: deviceName(agent),
    createdAt: iat * 1000, lastSeenAt: Date.now(), expiresAt: exp * 1000, generation };
  try {
    fs.writeFileSync(path.join(folder, `${record.id}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

function readRecord(dataDir: string, id: string): StoredSession | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory(dataDir), `${id}.json`), 'utf8')) as StoredSession;
    if (value.id !== id || typeof value.name !== 'string' || value.name.length > 100 ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) ||
      typeof value.generation !== 'string') return null;
    return value;
  } catch { return null; }
}

export function sessionRegistered(dataDir: string, sid: string, generation: string): boolean {
  const id = identifier(sid);
  const folder = directory(dataDir);
  const record = readRecord(dataDir, id);
  if (!record || record.generation !== generation || record.expiresAt <= Date.now() ||
    fs.existsSync(path.join(folder, `${id}.revoked`))) return false;
  try {
    const file = path.join(folder, `${id}.json`);
    // Touch metadata separately from revocation so concurrent reads cannot revive a device.
    if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.utimesSync(file, new Date(), new Date());
  } catch { return false; }
  return true;
}

export function listDeviceSessions(dataDir: string, generation: string): DeviceSession[] {
  const folder = directory(dataDir);
  let names: string[];
  try { names = fs.readdirSync(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    const id = name.slice(0, -5);
    const record = readRecord(dataDir, id);
    if (!record || record.generation !== generation || record.expiresAt <= Date.now() ||
      fs.existsSync(path.join(folder, `${id}.revoked`))) return [];
    const { generation: _generation, ...visible } = record;
    return [{ ...visible, lastSeenAt: fs.statSync(path.join(folder, name)).mtimeMs }];
  }).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function revokeDeviceSession(dataDir: string, id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id) || !readRecord(dataDir, id)) throw new Error('设备认证记录不存在。');
  const file = fs.openSync(path.join(directory(dataDir), `${id}.revoked`), 'w', 0o600);
  try { fs.writeFileSync(file, 'revoked\n'); fs.fsyncSync(file); }
  finally { fs.closeSync(file); }
}
