import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { listDeviceSessions, registerSession, revokeDeviceSession, sessionRegistered } from './session-store.js';

interface AuthRecord {
  version: 1;
  salt: string;
  hash: string;
  updatedAt: string;
  generation?: string;
}

interface SessionPayload {
  sid: string;
  exp: number;
  iat: number;
  generation?: string;
  version?: 2;
}

const COOKIE_NAME = 'codex_remote_session';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonPrivate(filePath: string, value: unknown): void {
  ensureDataDir();
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temp, filePath); }
  finally { fs.rmSync(temp, { force: true }); }
}

function getSessionSecret(): Buffer {
  ensureDataDir();
  try {
    const stored = fs.readFileSync(config.secretFile, 'utf8').trim();
    if (stored.length >= 64) return Buffer.from(stored, 'base64url');
  } catch {
    // Generate below.
  }

  const secret = crypto.randomBytes(48);
  fs.writeFileSync(config.secretFile, secret.toString('base64url'), { mode: 0o600 });
  return secret;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) { try { result[key] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ } }
  }
  return result;
}

export function isPasswordConfigured(): boolean {
  return Boolean(readJson<AuthRecord>(config.authFile)?.hash);
}

export async function setPassword(password: string): Promise<void> {
  const normalized = password.trim();
  if (normalized.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const salt = crypto.randomBytes(16);
  const hash = await scrypt(normalized, salt);
  writeJsonPrivate(config.authFile, {
    version: 1,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
    updatedAt: new Date().toISOString(),
    generation: crypto.randomUUID()
  } satisfies AuthRecord);
}

export async function verifyPassword(password: string): Promise<boolean> {
  const record = readJson<AuthRecord>(config.authFile);
  if (!record?.hash || !record.salt) return false;

  const salt = Buffer.from(record.salt, 'base64url');
  const expected = Buffer.from(record.hash, 'base64url');
  const actual = await scrypt(password, salt);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function sessionGeneration(): string {
  const record = readJson<AuthRecord>(config.authFile);
  if (!record) {
    if (fs.existsSync(config.authFile)) throw new Error('认证文件无法读取。');
    return 'legacy';
  }
  return record.generation || 'legacy';
}

export function authenticatedDevices() {
  const generation = sessionGeneration();
  const devices = listDeviceSessions(config.dataDir, generation);
  return { devices: devices.slice(0, 200), deviceCount: devices.length, legacyDevicesPossible: generation === 'legacy' };
}

export function revokeDevice(id: string): void {
  revokeDeviceSession(config.dataDir, id);
}

export function revokeAllDevices(): void {
  const record = readJson<AuthRecord>(config.authFile);
  if (!record?.hash) throw new Error('尚未设置访问密码。');
  writeJsonPrivate(config.authFile, { ...record, generation: crypto.randomUUID() });
}

export function issueSession(agent?: string): string {
  const secret = getSessionSecret();
  const payload: SessionPayload = {
    sid: crypto.randomBytes(24).toString('base64url'),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + config.sessionDays * 24 * 60 * 60,
    generation: sessionGeneration(),
    version: 2
  };
  registerSession(config.dataDir, payload.sid, payload.iat, payload.exp, payload.generation!, agent);
  const encoded = base64UrlJson(payload);
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string | undefined, agent?: string): SessionPayload | null {
  if (!token || token.length > 4096 || token.split('.').length !== 2) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const secret = getSessionSecret();
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (expected.length !== signature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.sid !== 'string' || !/^[a-zA-Z0-9_-]{32}$/.test(payload.sid) ||
      !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
      payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const generation = sessionGeneration();
    if ((payload.generation || 'legacy') !== generation) return null;
    if (!payload.version) registerSession(config.dataDir, payload.sid, payload.iat, payload.exp, generation, agent);
    if (!sessionRegistered(config.dataDir, payload.sid, generation)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readSessionCookie(cookieHeader: string | undefined, agent?: string): SessionPayload | null {
  const cookies = parseCookies(cookieHeader);
  return verifySessionToken(cookies[COOKIE_NAME], agent);
}

export function revokeSessionCookie(cookieHeader: string | undefined): void {
  const session = readSessionCookie(cookieHeader);
  if (session) revokeDevice(crypto.createHash('sha256').update(session.sid).digest('hex'));
}

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = config.sessionDays * 24 * 60 * 60;
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    secure ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export function authFilePath(): string {
  return path.resolve(config.authFile);
}
