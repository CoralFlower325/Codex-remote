import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);
const SHIM_NAME = 'codex-remote-cli.exe';

export interface DesktopShimStatus {
  configured: boolean;
  directory: string;
  endpointFile: string;
  error?: string;
}

async function configureUserEnvironment(directory: string): Promise<void> {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(directory, 'configure-desktop-shim.ps1'), '-Directory', directory],
  { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
}

export async function ensureDesktopShim(platform = process.platform): Promise<DesktopShimStatus> {
  if (platform !== 'win32') {
    return {
      configured: false,
      directory: path.dirname(config.appServerEndpointFile),
      endpointFile: config.appServerEndpointFile,
      error: '当前平台尚未启用共享 App Server 适配层。'
    };
  }
  const directory = path.resolve(process.cwd(), 'dist', 'desktop-shim');
  const executable = path.join(directory, SHIM_NAME);
  const proxy = path.join(directory, 'desktop-cli-proxy.mjs');
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    fs.accessSync(proxy, fs.constants.R_OK);
    fs.mkdirSync(path.dirname(config.appServerEndpointFile), { recursive: true, mode: 0o700 });
    const lines = [
      `node=${process.execPath}`,
      `proxy=${proxy}`,
      `realCodex=${config.codexBinary}`,
      `endpointFile=${config.appServerEndpointFile}`,
      `log=${path.join(config.dataDir, 'desktop-shim', 'desktop-cli-shim.log')}`
    ];
    fs.writeFileSync(path.join(directory, 'codex-remote-shim.ini'), `${lines.join('\n')}\n`, 'utf8');
    await configureUserEnvironment(directory);
    return { configured: true, directory, endpointFile: config.appServerEndpointFile };
  } catch (error) {
    return {
      configured: false,
      directory,
      endpointFile: config.appServerEndpointFile,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export const desktopShimStatus: DesktopShimStatus = {
  configured: false,
  directory: path.resolve(process.cwd(), 'dist', 'desktop-shim'),
  endpointFile: config.appServerEndpointFile
};
