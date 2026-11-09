import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';

export interface TunnelMetricsState {
  port: number;
  pid: number;
  owner: string;
  startedAt: number;
}

export function tunnelMetricsPath(root: string): string {
  return path.join(root, 'data', 'tunnel-metrics.json');
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('No tunnel metrics port was allocated.')));
    });
  });
}

export async function writeTunnelMetricsState(root: string, state: TunnelMetricsState): Promise<void> {
  const target = tunnelMetricsPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function clearTunnelMetricsState(root: string, owner: string): Promise<void> {
  const target = tunnelMetricsPath(root);
  try {
    const state = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<TunnelMetricsState>;
    if (state.owner === owner) await fs.rm(target, { force: true });
  } catch { /* Missing or already replaced state is not ours to remove. */ }
}
