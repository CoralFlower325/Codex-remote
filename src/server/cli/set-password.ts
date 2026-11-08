import { authFilePath, setPassword } from '../auth.js';
import { hiddenPasswordPrompt } from './password-prompt.js';

const prompt = hiddenPasswordPrompt(process.stdin, process.stdout, Boolean(process.stdin.isTTY));
try {
  const envPassword = process.env.CODEX_REMOTE_PASSWORD?.trim();
  const password = envPassword || (await prompt.question('New access password (12+ chars, hidden): ')).trim();
  const confirm = envPassword || (await prompt.question('Confirm password: ')).trim();
  if (password !== confirm) {
    throw new Error('Passwords do not match.');
  }
  await setPassword(password);
  console.log(`Password saved to ${authFilePath()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  prompt.close();
}
