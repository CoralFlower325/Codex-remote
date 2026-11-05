import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/desktop-relay/automations.ts'],
  outfile: 'dist/desktop-relay/automations.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  legalComments: 'inline',
  banner: { js: `/*\n${await readFile('node_modules/capnweb/LICENSE.txt', 'utf8')}\n*/` },
  minify: true
});
