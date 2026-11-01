import type { Request } from 'express';

export function proxyTrust(value = process.env.TRUST_PROXY): false | string[] {
  if (value === '0') return false;
  // "1" historically meant every proxy. Keep local tunnel deployments working
  // while accepting forwarding headers only from explicitly trusted upstreams.
  return !value || value === '1' ? ['loopback'] : value.split(',').map(part => part.trim()).filter(Boolean);
}

export function localSetupRequest(req: Request): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return (address === '127.0.0.1' || address === '::1') &&
    !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip']
      .some(header => req.get(header) !== undefined);
}

export class LoginBudget {
  private attempts = new Map<string, { count: number; blockedUntil: number; lastAttempt: number }>();
  private pending = new Map<string, number>();
  private total = 0;

  begin(key: string, now = Date.now()): { retryAfter: number } | { finish: (valid: boolean) => void } {
    for (const [id, value] of this.attempts) {
      if (now - value.lastAttempt > 10 * 60_000 && value.blockedUntil <= now) this.attempts.delete(id);
    }
    const previous = this.attempts.get(key);
    if (previous && previous.blockedUntil > now) {
      return { retryAfter: Math.ceil((previous.blockedUntil - now) / 1000) };
    }
    if (this.total >= 4 || (this.pending.get(key) ?? 0) >= 2 ||
      !previous && this.attempts.size >= 1000) return { retryAfter: 2 };
    this.total++;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    let finished = false;
    return { finish: valid => {
      if (finished) return;
      finished = true;
      this.total--;
      const pending = (this.pending.get(key) ?? 1) - 1;
      if (pending) this.pending.set(key, pending); else this.pending.delete(key);
      if (valid) { this.attempts.delete(key); return; }
      const at = Date.now();
      const entry = this.attempts.get(key) ?? { count: 0, blockedUntil: 0, lastAttempt: at };
      entry.count++;
      entry.lastAttempt = at;
      entry.blockedUntil = entry.count >= 5 ? at + Math.min(10 * 60_000, entry.count * 20_000) : 0;
      this.attempts.set(key, entry);
    } };
  }
}
