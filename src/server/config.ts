import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOriginList, resolvePublicOrigins } from './origin-policy.js';
import { proxyTrust } from './request-security.js';

export interface AppConfig {
  host: string;
  port: number;
  publicOrigin: string | null;
  publicOrigins: string[];
  allowedOrigins: string[];
  trustProxy: false | string[];
  sessionDays: number;
  sessionIdleHours: number;
  dataDir: string;
  authFile: string;
  secretFile: string;
  codexHome: string;
  codexWorkdir: string;
  codexBinary: string;
  codexBinaryCandidates: string[];
  lanPort: number;
  lanOrigins: string[];
  lanCertificate: string | null;
  lanKey: string | null;
  lanAllowHttp: boolean;
}

function newestDirectories(directory: string, accept: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && accept(entry.name))
      .map((entry) => {
        const fullPath = path.join(directory, entry.name);
        try {
          return { fullPath, modifiedAt: fs.statSync(fullPath).mtimeMs };
        } catch {
          return { fullPath, modifiedAt: 0 };
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((entry) => entry.fullPath);
  } catch {
    return [];
  }
}

function windowsCodexBinaryCandidates(): string[] {
  const candidates: string[] = [];
  const programFiles = process.env.ProgramFiles?.trim();
  if (programFiles) {
    const packagesDir = path.join(programFiles, 'WindowsApps');
    for (const packageDir of newestDirectories(packagesDir, (name) => name.startsWith('OpenAI.Codex_'))) {
      candidates.push(path.join(packageDir, 'app', 'resources', 'codex.exe'));
    }
  }

  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  const localBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  for (const versionDir of newestDirectories(localBin, () => true)) {
    candidates.push(path.join(versionDir, 'codex.exe'));
  }
  candidates.push(path.join(localBin, 'codex.exe'), 'codex.exe');
  return [...new Set(candidates)];
}

function unixCodexBinaryCandidates(): string[] {
  return [
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    path.join(os.homedir(), '.codex/packages/standalone/current/codex'),
    'codex'
  ];
}

export function codexBinaryCandidates(platform = process.platform): string[] {
  return platform === 'win32' ? windowsCodexBinaryCandidates() : unixCodexBinaryCandidates();
}

function resolveCodexBinary(candidates: string[]): string {
  const explicit = process.env.CODEX_BINARY?.trim();
  if (explicit) return explicit;

  // Desktop owns execution; locating its optional binary must not spawn processes
  // or delay authentication at module import time.
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates.at(-1) ?? 'codex';
}

const dataDir = path.resolve(process.env.DATA_DIR?.trim() || 'data');
const codexHome = path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'));
const { publicOrigin, publicOrigins } = resolvePublicOrigins(
  process.env.PUBLIC_ORIGIN,
  process.env.PUBLIC_ORIGINS
);
const binaryCandidates = codexBinaryCandidates();
const lanPort = Number.parseInt(process.env.LAN_PORT?.trim() || '0', 10);
const lanAddresses = Object.values(os.networkInterfaces()).flat().filter(
  (address): address is os.NetworkInterfaceInfo => Boolean(address && !address.internal && address.family === 'IPv4'));
const lanOrigins = lanPort ? [...new Set([
  ...(process.env.LAN_ADDRESS ? [process.env.LAN_ADDRESS] : []), ...lanAddresses.map(address => address.address)
])].map(address => `${process.env.LAN_CERT_FILE && process.env.LAN_KEY_FILE ? 'https' : 'http'}://${address}:${lanPort}`) : [];

export const config: AppConfig = {
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: Number.parseInt(process.env.PORT?.trim() || '4545', 10),
  publicOrigin,
  publicOrigins,
  allowedOrigins: [...new Set([
    ...publicOrigins,
    ...parseOriginList(process.env.ALLOWED_ORIGINS, 'ALLOWED_ORIGINS'),
    ...lanOrigins
  ])],
  lanPort,
  lanOrigins,
  lanCertificate: process.env.LAN_CERT_FILE?.trim() || null,
  lanKey: process.env.LAN_KEY_FILE?.trim() || null,
  lanAllowHttp: process.env.LAN_ALLOW_HTTP === '1',
  trustProxy: proxyTrust(),
  sessionDays: Math.min(30, Math.max(1, Number.parseInt(process.env.SESSION_DAYS?.trim() || '7', 10) || 7)),
  sessionIdleHours: Math.min(168, Math.max(1, Number.parseInt(process.env.SESSION_IDLE_HOURS?.trim() || '24', 10) || 24)),
  dataDir,
  authFile: path.join(dataDir, 'auth.json'),
  secretFile: path.join(dataDir, 'session-secret'),
  codexHome,
  codexWorkdir: path.resolve(process.env.CODEX_WORKDIR?.trim() || os.homedir()),
  codexBinary: resolveCodexBinary(binaryCandidates),
  codexBinaryCandidates: binaryCandidates
};
