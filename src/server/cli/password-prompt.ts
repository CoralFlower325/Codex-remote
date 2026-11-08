import readline from 'node:readline';
import { Writable, type Readable } from 'node:stream';

export function hiddenPasswordPrompt(input: Readable, output: Writable, terminal = false) {
  let muted = false;
  const quietOutput = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    }
  });
  const rl = readline.createInterface({ input, output: quietOutput, terminal });
  let ended = false;
  rl.once('close', () => { ended = true; });
  return {
    question(prompt: string): Promise<string> {
      if (ended) return Promise.reject(new Error('Password entry ended before completion.'));
      return new Promise((resolve, reject) => {
        const cleanup = () => { rl.off('SIGINT', interrupted); rl.off('close', closed); };
        const closed = () => { cleanup(); reject(new Error('Password entry ended before completion.')); };
        const interrupted = () => { cleanup(); rl.close(); reject(new Error('Password entry cancelled.')); };
        rl.once('SIGINT', interrupted);
        rl.once('close', closed);
        muted = false;
        rl.question(prompt, answer => {
          muted = false;
          cleanup();
          output.write('\n');
          resolve(answer);
        });
        muted = true;
      });
    },
    close() { rl.close(); }
  };
}
