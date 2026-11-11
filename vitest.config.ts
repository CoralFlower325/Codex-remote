import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'desktop/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', 'node_modules.pnpm-backup/**', 'dist/**', 'dist-server/**'],
    // Windows PTY, PowerShell job and updater transaction tests contend for
    // process, pipe and file-system resources; keep that suite deterministic.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: process.platform === 'win32' ? 1 : undefined
  }
});
