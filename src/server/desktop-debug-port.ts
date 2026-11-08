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
const macProcessLine = /^\s*\d+\s+([0-9:-]+)\s+(.+)$/;
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

function macTrustedExecutables(environment: NodeJS.ProcessEnv): string[] {
  const applications = ['/Applications'];
  if (environment.HOME) applications.push(path.posix.join(environment.HOME, 'Applications'));
  return [...new Set(applications.flatMap(root => [
    path.posix.join(root, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
    path.posix.join(root, 'Codex.app', 'Contents', 'MacOS', 'Codex')
  ]))];
}

function macDesktopExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  return macTrustedExecutables(environment).find(executable =>
    command === executable || command.startsWith(`${executable} `)) ?? null;
}

function elapsedSeconds(value: string): number {
  const separator = value.indexOf('-');
  const days = separator >= 0 ? value.slice(0, separator) : '0';
  const clock = separator >= 0 ? value.slice(separator + 1) : value;
  const parts = clock.split(':').map(Number);
  if (parts.some(part => !Number.isInteger(part) || part < 0)) return Number.POSITIVE_INFINITY;
  const seconds = parts.length === 2 ? parts[0]! * 60 + parts[1]!
    : parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : Number.POSITIVE_INFINITY;
  return Number(days) * 86_400 + seconds;
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

export function parseMacosDesktopDiscovery(output: string,
  environment: NodeJS.ProcessEnv = process.env): number[] {
  const candidates = output.split(/\r?\n/).flatMap(line => {
    const match = macProcessLine.exec(line);
    if (!match) return [];
    const elapsedText = match[1];
    const command = match[2];
    if (!elapsedText || !command) return [];
    const elapsed = elapsedSeconds(elapsedText);
    if (/(?:^|\s)--type(?:=|\s+)/i.test(command)) return [];
    const executable = macDesktopExecutable(command, environment);
    if (!executable) return [];
    const args = command.slice(executable.length);
    const port = Number(portArgument.exec(args)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
    const addressMatch = addressArgument.exec(args);
    const address = addressMatch?.[1] ?? addressMatch?.[2] ?? addressMatch?.[3];
    if (!loopbackAddress(address)) return [];
    return [{ port, elapsed }];
  });
  return [...new Map(candidates
    .sort((left, right) => left.elapsed - right.elapsed)
    .map(candidate => [candidate.port, candidate.port])).values()];
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

export async function discoverMacosDesktopDebugPorts(options: DiscoveryOptions = {}): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return [];
  const environment = options.environment ?? process.env;
  try {
    const output = await (options.execute ?? executeHidden)('/bin/ps', ['-axo', 'pid=,etime=,command=']);
    return parseMacosDesktopDiscovery(output, environment);
  } catch {
    return [];
  }
}

export async function discoverDesktopDebugPorts(options: DiscoveryOptions = {}): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  return platform === 'win32' ? discoverWindowsDesktopDebugPorts(options)
    : platform === 'darwin' ? discoverMacosDesktopDebugPorts(options)
      : [];
}
