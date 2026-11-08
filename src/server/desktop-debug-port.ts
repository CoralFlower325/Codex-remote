import { execFile } from 'node:child_process';
import path from 'node:path';

interface WindowsProcess {
  ProcessId?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
  CreationDate?: unknown;
}

interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execute?: (file: string, args: string[]) => Promise<string>;
}

const portArgument = /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d{1,5})(?=\s|$)/i;
const addressArgument = /(?:^|\s)--remote-debugging-address(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const processQuery = [
  "$ErrorActionPreference = 'Stop';",
  "$items = @(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\"",
  "| Where-Object { $_.CommandLine -match '--remote-debugging-port(?:=|\\s+)'",
  "-and $_.CommandLine -notmatch '--type=' }",
  "| Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate);",
  'if ($items.Count -gt 0) { ConvertTo-Json -InputObject $items -Depth 3 -Compress; }'
].join(' ');

function normalizedPath(value: string): string {
  return path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
}

function trustedRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const programRoots = [environment.ProgramFiles, environment['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value));
  for (const root of programRoots) {
    const windowsApps = path.win32.join(root, 'WindowsApps');
    roots.push(
      path.win32.join(windowsApps, 'OpenAI.Codex_'),
      path.win32.join(windowsApps, 'OpenAI.ChatGPT_'),
      path.win32.join(root, 'OpenAI', 'Codex') + '\\',
      path.win32.join(root, 'OpenAI', 'ChatGPT') + '\\'
    );
  }
  if (environment.LOCALAPPDATA) {
    const programs = path.win32.join(environment.LOCALAPPDATA, 'Programs');
    roots.push(
      path.win32.join(programs, 'Codex') + '\\',
      path.win32.join(programs, 'ChatGPT') + '\\',
      path.win32.join(programs, 'OpenAI', 'Codex') + '\\',
      path.win32.join(programs, 'OpenAI', 'ChatGPT') + '\\'
    );
  }
  return roots.map(normalizedPath);
}

function trustedDesktopExecutable(value: string, environment: NodeJS.ProcessEnv): boolean {
  const executable = normalizedPath(value);
  const name = path.win32.basename(executable);
  if (name !== 'chatgpt.exe' && name !== 'codex.exe') return false;
  return trustedRoots(environment).some(root => executable.startsWith(root));
}

function loopbackAddress(value: string | undefined): boolean {
  return value === undefined || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value.toLowerCase());
}

function creationTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const wmi = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  const parsed = wmi ? Number(wmi[1]) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseWindowsDesktopDebugPorts(value: unknown,
  environment: NodeJS.ProcessEnv = process.env): number[] {
  const records = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is WindowsProcess => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
  const candidates = records.flatMap(record => {
    if (typeof record.ExecutablePath !== 'string' || typeof record.CommandLine !== 'string' ||
      !trustedDesktopExecutable(record.ExecutablePath, environment)) return [];
    const command = record.CommandLine;
    if (/(?:^|\s)--type(?:=|\s+)/i.test(command)) return [];
    const port = Number(portArgument.exec(command)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
    const addressMatch = addressArgument.exec(command);
    const address = addressMatch?.[1] ?? addressMatch?.[2] ?? addressMatch?.[3];
    if (!loopbackAddress(address)) return [];
    return [{ port, createdAt: creationTime(record.CreationDate) }];
  });
  return [...new Map(candidates
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(candidate => [candidate.port, candidate.port])).values()];
}

export function parseWindowsDesktopDiscovery(output: string,
  environment: NodeJS.ProcessEnv = process.env): number[] {
  const text = output.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try {
    return parseWindowsDesktopDebugPorts(JSON.parse(text), environment);
  } catch {
    return [];
  }
}

function executeHidden(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 256 * 1024
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function discoverWindowsDesktopDebugPorts(options: DiscoveryOptions = {}): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const environment = options.environment ?? process.env;
  const executable = environment.SystemRoot
    ? path.win32.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  try {
    const output = await (options.execute ?? executeHidden)(executable,
      ['-NoProfile', '-NonInteractive', '-Command', processQuery]);
    return parseWindowsDesktopDiscovery(output, environment);
  } catch {
    return [];
  }
}
