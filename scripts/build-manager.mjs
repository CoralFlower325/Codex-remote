import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

await build({ configFile: path.resolve('vite.manager.config.ts') });
await fs.copyFile('desktop/assets/app.png', 'desktop/dist/app.png');
