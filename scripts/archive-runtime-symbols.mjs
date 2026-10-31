import fs from 'node:fs/promises';
import path from 'node:path';
import { c as archive } from 'tar';

const files = [];
async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(name);
    else if (entry.isFile() && path.extname(name).toLowerCase() === '.pdb') files.push(name);
  }
}
await visit('node_modules');
if (files.length) {
  await fs.mkdir('output/runtime-symbols', { recursive: true });
  await archive({ file: `output/runtime-symbols/${process.platform}-${process.arch}.tar.gz`,
    gzip: true, portable: true, noMtime: true }, files.sort());
}
