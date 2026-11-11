import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'desktop/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', 'node_modules.pnpm-backup/**', 'dist/**', 'dist-server/**'],
    // Windows runners serialize enough file-system work that the default
    // five-second timeout can fail healthy updater transactions under load.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: process.platform === 'win32' ? 4 : undefined
  }
});
