import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hiddenPasswordPrompt } from './password-prompt.js';

function setup() {
  vi.stubEnv('TERM', 'xterm');
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  const prompt = hiddenPasswordPrompt(input, output, true);
  return { input, chunks, prompt };
}
afterEach(() => vi.unstubAllEnvs());
describe('hidden password entry', () => {
  it('shows prompts while hiding typed values, backspaces and confirmation input', async () => {
    const { input, chunks, prompt } = setup();
    try {
      const password = prompt.question('Password: ');
      for (const key of 'private-test-x\x08value\r') input.write(key);
      expect(await password).toBe('private-test-value');
      const confirmation = prompt.question('Confirm: ');
      input.write('private-test-value\r');
      expect(await confirmation).toBe('private-test-value');
      const visible = chunks.join('');
      expect(visible).toContain('Password: ');
      expect(visible).toContain('Confirm: ');
      expect(visible).not.toContain('private');
      expect(visible).not.toContain('value');
    } finally { prompt.close(); }
  });

  it('rejects EOF and cancellation instead of hanging with a partial password', async () => {
    const { input, prompt } = setup();
    const question = prompt.question('Password: ');
    input.write('partial');
    input.end();
    await expect(question).rejects.toThrow('ended before completion');
    const cancelled = setup();
    const next = cancelled.prompt.question('Password: ');
    cancelled.input.write('\x03');
    await expect(next).rejects.toThrow('cancelled');
  });
});
