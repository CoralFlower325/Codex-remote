import { Router, type Request, type Response } from 'express';

export interface RemotePeer {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

class HttpPeer implements RemotePeer {
  readyState = 1;
  constructor(private response: Response) {}
  get bufferedAmount(): number { return this.response.writableLength; }
  send(data: string): void {
    if (this.readyState === 1) this.response.write(`data: ${data}\n\n`);
  }
  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.response.end();
  }
}

export function httpConnections({
  session, connect, disconnect, message
}: {
  session: (req: Request) => string;
  connect: (peer: RemotePeer, req: Request) => void;
  disconnect: (peer: RemotePeer) => void;
  message: (peer: RemotePeer, raw: string) => Promise<void>;
}): Router {
  const router = Router();
  const peers = new Map<string, HttpPeer>();
  const key = (req: Request) => typeof req.query.id === 'string'
    && /^[a-zA-Z0-9-]{1,80}$/.test(req.query.id) ? `${session(req)}:${req.query.id}` : null;
  router.get('/', (req, res) => {
    const id = key(req);
    if (!id) { res.status(400).json({ error: 'A connection id is required.' }); return; }
    peers.get(id)?.close();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const peer = new HttpPeer(res);
    peers.set(id, peer);
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15_000);
    keepalive.unref();
    res.on('close', () => {
      clearInterval(keepalive);
      peer.readyState = 3;
      if (peers.get(id) === peer) peers.delete(id);
      disconnect(peer);
    });
    connect(peer, req);
  });
  router.post('/', (req, res) => {
    const id = key(req);
    const peer = id ? peers.get(id) : undefined;
    if (!peer || peer.readyState !== 1) {
      res.status(409).json({ error: 'Remote HTTP connection is no longer active.' });
      return;
    }
    // Acknowledge receipt before native work finishes; never retry this POST.
    const work = message(peer, JSON.stringify(req.body));
    res.status(202).end();
    void work.catch(() => peer.close());
  });
  return router;
}
