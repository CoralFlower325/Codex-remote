import fs from 'node:fs/promises';
import path from 'node:path';
import { installation, commandEnvironment } from './controller.mjs';
import { run } from './process.mjs';

export async function manageAuthentication(directory, request, execute = run) {
  const info = await installation(directory);
  const script = path.join(info.root, 'dist-server/server/cli/manage-auth.js');
  try { await fs.access(script); }
  catch {
    if (request.action === 'list') return { supported: false, devices: [] };
    throw new Error('请先更新本机 Remote，再管理密码和设备。');
  }
  if (!['list', 'password', 'revoke', 'revoke-all'].includes(request.action)) throw new Error('未知认证操作。');
  const output = await execute('node', [script], { cwd: info.root, timeout: 15_000, raw: true,
    env: { ...commandEnvironment(), DOTENV_CONFIG_QUIET: 'true' }, input: JSON.stringify(request) });
  const value = JSON.parse(output.toString('utf8'));
  if (value.supported !== true || !Array.isArray(value.devices)) throw new Error('本机认证响应无效。');
  return value;
}
