import type { RemotePeer } from './http-connections.js';

export class SessionConnections {
  private checks = new Map<RemotePeer, () => boolean>();
  private rejected = new WeakSet<RemotePeer>();
  private verifiedAt = new WeakMap<RemotePeer, number>();
  private timer = setInterval(() => {
    for (const peer of this.checks.keys()) this.allowed(peer);
  }, 5000).unref();

  add(peer: RemotePeer, valid: () => boolean): void { this.checks.set(peer, valid); }
  delete(peer: RemotePeer): void { this.checks.delete(peer); }
  allowed(peer: RemotePeer, fresh = true): boolean {
    if (this.rejected.has(peer)) return false;
    const check = this.checks.get(peer);
    if (!check) return true;
    if (!fresh && Date.now() - (this.verifiedAt.get(peer) ?? -Infinity) < 1000) return true;
    try {
      if (check()) { this.verifiedAt.set(peer, Date.now()); return true; }
    } catch { /* Invalid storage fails closed. */ }
    this.checks.delete(peer);
    this.rejected.add(peer);
    peer.close(1008, 'Authentication expired');
    return false;
  }
  dispose(): void { clearInterval(this.timer); this.checks.clear(); }
}
