import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionLedger } from './action-ledger.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-actions-'));
  directories.push(directory);
  return { directory, ledger: new ActionLedger(directory), id: crypto.randomUUID() };
}
describe('durable native action confirmation', () => {
  it('persists uncertainty before dispatch and refuses native execution when storage is unavailable', async () => {
    const { directory, ledger, id } = await fixture();
    const dispatch = vi.fn(async () => {
      const persisted = JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8'));
      expect(persisted.state).toBe('pending');
      expect(typeof persisted.fingerprint).toBe('string');
      return { ok: true };
    });
    await ledger.execute(id, 'turn/start', {}, dispatch);
    const blocked = path.join(directory, 'blocked');
    await fs.writeFile(blocked, 'not a directory');
    const unavailable = vi.fn(async () => ({ ok: true }));
    await expect(new ActionLedger(blocked).execute(crypto.randomUUID(), 'turn/start', {}, unavailable))
      .rejects.toThrow();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('returns the confirmed result after a process restart without resubmitting', async () => {
    const { directory, ledger, id } = await fixture();
    const dispatch = vi.fn(async () => ({ turn: { id: 'turn-a' } }));
    await ledger.execute(id, 'turn/start', { threadId: 'a' }, dispatch);
    expect(await new ActionLedger(directory).execute(id, 'turn/start', { threadId: 'a' }, dispatch))
      .toEqual({ turn: { id: 'turn-a' } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(ledger.execute(id, 'turn/start', { threadId: 'b' }, dispatch)).rejects.toThrow('另一项');
  });
  it('does not replay an action with a lost native acknowledgement', async () => {
    const { directory, ledger, id } = await fixture();
    const dispatch = vi.fn(async () => { throw new Error('socket closed'); });
    await expect(ledger.execute(id, 'turn/start', {}, dispatch)).rejects.toThrow('阻止');
    await expect(new ActionLedger(directory).execute(id, 'turn/start', {}, dispatch)).rejects.toThrow('阻止');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent dispatch attempts or blocks a race before native execution', async () => {
    const { ledger, id } = await fixture();
    const dispatch = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true }; });
    const results = await Promise.allSettled([ledger.execute(id, 'turn/start', {}, dispatch),
      ledger.execute(id, 'turn/start', {}, dispatch)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
