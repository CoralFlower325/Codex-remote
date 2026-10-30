import fs from 'node:fs/promises';
import path from 'node:path';
import { installUpdate } from '../updater.mjs';
import { recoverPendingUpdate } from '../update-transaction.mjs';
import { sha256 } from '../runtime-package.mjs';

const [rootArgument, stage, checkpoint, running] = process.argv.slice(2);
const root = await fs.realpath(rootArgument);
const hang = async () => {
  process.send?.('checkpoint');
  await new Promise(() => { setInterval(() => {}, 1000); });
};
const rename = fs.rename.bind(fs);
fs.rename = async (source, target) => {
  if (checkpoint === 'file-write' && target === path.join(root, 'package.json')) await hang();
  await rename(source, target);
  if (checkpoint === 'dependencies' && source === path.join(root, 'node_modules')) await hang();
  if (checkpoint === 'source' && target === path.join(root, 'package.json')) await hang();
};
const controls = {
  stop: async () => {
    await fs.writeFile(path.join(root, 'service-state'), 'stopped');
    if (checkpoint === 'stop') await hang();
  },
  start: async () => { await fs.writeFile(path.join(root, 'service-state'), 'running'); },
  verify: async () => { if (checkpoint === 'verify') await hang(); },
  isRunning: async () => running === 'true', progress: () => {}
};
if (checkpoint === 'recovery') {
  const cp = fs.cp.bind(fs);
  fs.cp = async (source, target, options) => {
    if (target === path.join(root, 'node_modules')) {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'partial'), 'interrupted restore');
      await hang();
    }
    return cp(source, target, options);
  };
  await recoverPendingUpdate(root, controls);
} else {
  await installUpdate({ info: { root: rootArgument, version: '0.1.13' }, stage, payload: stage, mode: 'runtime',
    tools: {}, execute: () => { throw new Error('npm must not execute'); }, release: { version: '0.1.14' },
    plan: [{ relative: 'package.json', before: sha256(await fs.readFile(path.join(root, 'package.json'))), remove: false }],
    commit: 'a'.repeat(40) }, controls);
}
