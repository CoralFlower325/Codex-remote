import type { RemotePeer } from './http-connections.js';

export class SessionConnections {
  private checks = new Map<RemotePeer, () => boolean>();
  private rejected = new WeakSet<RemotePeer>();
  private timer = setInterval(() => {
    for (const peer of this.checks.keys()) this.allowed(peer);
  }, 5000).unref();

  add(peer: RemotePeer, valid: () => boolean): void { this.checks.set(peer, valid); }
  delete(peer: RemotePeer): void { this.checks.delete(peer); }
  allowed(peer: RemotePeer): boolean {
    if (this.rejected.has(peer)) return false;
    const check = this.checks.get(peer);
    if (!check) return true;
    try { if (check()) return true; } catch { /* Invalid storage fails closed. */ }
    this.checks.delete(peer);
    this.rejected.add(peer);
    peer.close(1008, 'Authentication expired');
    return false;
  }
  dispose(): void { clearInterval(this.timer); this.checks.clear(); }
}
