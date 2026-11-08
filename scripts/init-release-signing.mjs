import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'CodexRemote', 'release-signing');
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
if (process.platform === 'win32') {
  const identity = execFileSync('whoami.exe', [], { encoding: 'utf8' }).trim();
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'ignore' });
}
const privateFile = path.join(directory, 'release-ed25519.pem');
let privateKey;
try { privateKey = await fs.readFile(privateFile, 'utf8'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const pair = crypto.generateKeyPairSync('ed25519');
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await fs.writeFile(privateFile, privateKey, { flag: 'wx', mode: 0o600 });
}
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
const keyId = crypto.createHash('sha256').update(publicKey).digest('hex');
const target = path.resolve('desktop/release-keys.mjs');
await fs.writeFile(target, `// Public trust roots only. Private signing keys must never enter this repository.\nexport const trustedReleaseKeys = ${JSON.stringify({ [keyId]: publicKey }, null, 2)};\n`, 'utf8');
console.log(`Public trust root: ${keyId}\nPrivate key retained outside repository: ${privateFile}\nCI secret required: RELEASE_SIGNING_KEY (not uploaded by this script)`);
