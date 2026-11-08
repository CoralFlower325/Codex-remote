import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';

export function lanOptions(args, existing = {}) {
  let port = 4546;
  let portSet = false;
  let allowHttp = false;
  let cert = existing.LAN_CERT_FILE || '';
  let key = existing.LAN_KEY_FILE || '';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--allow-http') allowHttp = true;
    else if (argument === '--cert' || argument === '--key') {
      const value = args[++index];
      if (!value || value.startsWith('--') || /[\r\n"]/.test(value)) throw new Error(`${argument} requires a file path.`);
      if (argument === '--cert') cert = value;
      else key = value;
    } else if (!portSet && /^\d+$/.test(argument)) { port = Number(argument); portSet = true; }
    else throw new Error(`Unknown LAN setup argument: ${argument}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an unused port from 1024 to 65535.');
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both --cert and --key for the LAN HTTPS listener.');
  if (!cert && !allowHttp) {
    throw new Error('LAN access requires TLS. Supply --cert <certificate.pem> --key <private-key.pem>, or explicitly accept plaintext with --allow-http.');
  }
  return { port, allowHttp, cert, key };
}

export function lanEnvironment(text, options, base = process.cwd()) {
  const rest = text.split(/\r?\n/).filter(line =>
    !/^\s*(?:export\s+)?LAN_(?:PORT|ALLOW_HTTP|CERT_FILE|KEY_FILE)\s*=/.test(line)).join('\n').trimEnd();
  const tls = options.cert ? `\nLAN_CERT_FILE=${JSON.stringify(path.resolve(base, options.cert).replaceAll('\\', '/'))}` +
    `\nLAN_KEY_FILE=${JSON.stringify(path.resolve(base, options.key).replaceAll('\\', '/'))}` : '';
  return `${rest}${rest ? '\n' : ''}LAN_PORT=${options.port}\nLAN_ALLOW_HTTP=${options.allowHttp ? '1' : '0'}${tls}\n`;
}

export function lanFirewallScript(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid LAN port.');
  return `$ErrorActionPreference = 'Stop'; $rule = Get-NetFirewallRule -DisplayName 'Codex Remote LAN' -ErrorAction SilentlyContinue; ` +
    `if ($rule) { $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Private,Domain | Out-Null; ` +
    `$rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort ${port} | Out-Null; ` +
    `$rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null } ` +
    `else { New-NetFirewallRule -DisplayName 'Codex Remote LAN' -Direction Inbound -Action Allow -Protocol TCP ` +
    `-LocalPort ${port} -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null }`;
}

export async function enableLan(args = process.argv.slice(2)) {
  const filename = new URL('../.env', import.meta.url);
  const base = path.dirname(fileURLToPath(filename));
  const text = await fs.readFile(filename, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const options = lanOptions(args, parse(text));
  if (options.cert) {
    await fs.access(path.resolve(base, options.cert));
    await fs.access(path.resolve(base, options.key));
  }
  await fs.writeFile(filename, lanEnvironment(text, options, base), { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', lanFirewallScript(options.port)],
      { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) {
      console.warn('Private/Domain LocalSubnet firewall setup requires administrator rights. Run this command as administrator if LAN access is blocked.');
    }
  }
  if (!options.cert) console.warn('Plaintext HTTP was explicitly enabled: passwords and session data are not encrypted on this LAN connection. Prefer HTTPS or a trusted encrypted VPN.');
  console.log(`LAN ${options.cert ? 'HTTPS' : 'HTTP'} listener configured on port ${options.port}. Restart Remote, then open a LAN address from the connection menu.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await enableLan();
