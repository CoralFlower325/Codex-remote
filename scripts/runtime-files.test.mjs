import { describe, expect, it } from 'vitest';
import { runtimeFile } from './runtime-files.mjs';

describe('runtime staging', () => {
  it.each([['win32', 'x64'], ['darwin', 'arm64']])('keeps the usable native files for %s-%s', (platform, arch) => {
    for (const target of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64']) {
      for (const name of ['pty.node', 'conpty.node', 'spawn-helper', 'conpty/OpenConsole.exe', 'conpty/conpty.dll']) {
        expect(runtimeFile(`node_modules/node-pty/prebuilds/${target}/${name}`, platform, arch))
          .toBe(target === `${platform}-${arch}`);
      }
    }
    expect(runtimeFile('node_modules/node-pty/build/Release/pty.node', platform, arch)).toBe(true);
  });
  it('excludes cache, command links and debug symbols without dropping runtime or source files', () => {
    for (const name of ['node_modules/.vitest-cache/results.json', 'node_modules/.bin/tsx',
      'node_modules/node-pty/prebuilds/win32-x64/conpty.pdb', 'node_modules/native/DEBUG.PDB']) {
      expect(runtimeFile(name)).toBe(false);
      expect(runtimeFile(name.replaceAll('/', '\\'))).toBe(false);
    }
    for (const name of ['src/client/components/ThreadTimeline.tsx', 'scripts/prepare-terminal.mjs',
      'node_modules/node-pty/lib/index.js', 'node_modules/unified/index.js', 'dist/client/assets/worker.js']) {
      expect(runtimeFile(name)).toBe(true);
    }
  });
});
