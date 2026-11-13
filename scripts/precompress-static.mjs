import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.mjs', '.svg', '.txt', '.webmanifest', '.xml'
]);

export function precompressDirectory(root) {
  const resolvedRoot = path.resolve(root);
  let files = 0;
  let inputBytes = 0;
  let outputBytes = 0;

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = fs.statSync(file);
      if (stat.size > 5 * 1024 * 1024) continue;
      const input = fs.readFileSync(file);
      const output = brotliCompressSync(input, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.length
        }
      });
      fs.writeFileSync(`${file}.br`, output);
      files++;
      inputBytes += input.length;
      outputBytes += output.length;
    }
  }

  walk(resolvedRoot);
  return { root: resolvedRoot, files, inputBytes, outputBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = precompressDirectory(process.argv[2] ?? 'dist/client');
  console.log(JSON.stringify(result));
}
