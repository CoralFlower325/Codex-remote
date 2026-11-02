import type { ServerMessage } from '../shared/protocol';
import { synchronizeHostClock } from './host-clock';
import { HttpChannel, type RemoteChannel } from './http-channel';
export type { RemoteChannel } from './http-channel';

interface ConnectionOptions<Message> {
  url: string;
  readyType?: string;
  httpFallback?: string;
  onSocket: (socket: RemoteChannel | null) => void;
  onOpen: () => void;
  onMessage: (message: Message) => void;
  onDisconnect: (error: Error) => void;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_PONG_TIMEOUT_MS = 12_000;

export class RemoteConnection<Message extends { type: string } = ServerMessage> {
  private socket: RemoteChannel | null = null;
  private stopped = true;
  private failures = 0;
  private reconnectTimer: number | undefined;
  private fallbackTimer: number | undefined;
  private fallbackSocket: RemoteChannel | null = null;
  private connectTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private pongTimer: number | undefined;
  private probeTimer: number | undefined;
  private probeDeadline: number | undefined;
  private probeSocket: RemoteChannel | null = null;
  private pingSentAtMs: number | undefined;
  private http = false;
  private suspended = false;
  private synchronized = false;
  private readonly networkInfo = (navigator as Navigator & { connection?: EventTarget }).connection;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;

  constructor(private readonly options: ConnectionOptions<Message>) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    if (options.httpFallback) {
      try { this.http = sessionStorage.getItem('remote-http-transport') === '1'; } catch { /* Optional route preference. */ }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
    window.addEventListener('focus', this.recover);
    window.addEventListener('pageshow', this.recover);
    document.addEventListener('visibilitychange', this.recover);
    this.networkInfo?.addEventListener('change', this.networkChanged);
    this.connect();
  }

  reconnect(): void {
    if (this.stopped) return;
    this.failures = 0;
    if (this.socket) this.disconnect(this.socket, 'Reconnecting to Remote...');
    this.connect();
  }

  dispose(): void {
    this.stopped = true;
    window.removeEventListener('online', this.online);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('focus', this.recover);
    window.removeEventListener('pageshow', this.recover);
    document.removeEventListener('visibilitychange', this.recover);
    this.networkInfo?.removeEventListener('change', this.networkChanged);
    window.clearTimeout(this.reconnectTimer);
    this.clearSocketTimers();
    const socket = this.socket;
    this.socket = null;
    this.options.onSocket(null);
    socket?.close();
  }

  private connect = (): void => {
    window.clearTimeout(this.reconnectTimer);
    if (this.stopped || this.socket || !navigator.onLine) return;
    const socket: RemoteChannel = this.http && this.options.httpFallback
      ? new HttpChannel(this.options.httpFallback) : new WebSocket(this.options.url);
    this.attach(socket);
    if (!this.http && this.options.httpFallback) {
      this.fallbackTimer = window.setTimeout(() => {
        this.fallbackTimer = undefined;
        if (this.stopped || this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
        const fallback = new HttpChannel(this.options.httpFallback!);
        this.fallbackSocket = fallback;
        fallback.addEventListener('open', () => {
          if (this.fallbackSocket === fallback && this.socket === socket &&
              socket.readyState === WebSocket.CONNECTING) {
            this.disconnect(socket, 'Selecting the available Remote transport.');
          }
        });
        fallback.addEventListener('error', () => {
          if (this.fallbackSocket !== fallback) return;
          this.fallbackSocket = null;
          fallback.close();
        });
      }, 500);
    }
  };

  private attach(socket: RemoteChannel): void {
    this.socket = socket;
    this.synchronized = false;
    this.suspended = document.visibilityState !== 'visible';
    this.options.onSocket(socket);
    this.armHandshake(socket);

    const opened = () => {
      if (this.socket !== socket || this.stopped) return;
      this.clearFallback();
      window.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      if (this.options.readyType) {
        this.armHandshake(socket);
      } else { this.failures = 0; this.synchronized = true; }
      this.options.onOpen();
      this.ping();
    };
    socket.addEventListener('open', opened);
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.stopped) return;
      let message: Message;
      try {
        message = JSON.parse(String((event as MessageEvent).data)) as Message;
      } catch {
        return;
      }
      if (message.type === 'pong') this.markAlive();
      if (message.type === this.options.readyType) {
        window.clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
        this.failures = 0;
        this.synchronized = true;
        if (this.http) {
          try { sessionStorage.setItem('remote-http-transport', '1'); } catch { /* Optional route preference. */ }
        }
      }
      if (message.type === 'pong') {
        if (this.pingSentAtMs !== undefined && 'at' in message && typeof message.at === 'string') {
          const serverTimeMs = Date.parse(message.at);
          if (Number.isFinite(serverTimeMs)) synchronizeHostClock(serverTimeMs, this.pingSentAtMs, Date.now());
        }
        this.pingSentAtMs = undefined;
      }
      this.options.onMessage(message);
    });
    socket.addEventListener('close', () => {
      this.disconnect(socket, 'Remote connection closed. Reconnecting...');
    });
    socket.addEventListener('error', event => {
      const error = (event as Event & { error?: Error }).error;
      this.disconnect(socket, error ?? 'Remote connection lost. Reconnecting...');
    });
    if (socket.readyState === WebSocket.OPEN) opened();
  }

  private armHandshake(socket: RemoteChannel): void {
    window.clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    if (document.visibilityState !== 'visible') return;
    const connecting = socket.readyState === WebSocket.CONNECTING;
    const timeout = this.http ? 12_000 : connecting && this.options.httpFallback ? 3000 : 6000;
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = undefined;
      if (document.visibilityState !== 'visible') { this.suspended = true; return; }
      this.disconnect(socket, connecting
        ? 'Remote connection timed out. Reconnecting...'
        : 'Remote synchronization timed out. Reconnecting...');
    }, timeout);
  }

  private clearSocketTimers(): void {
    window.clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.clearHeartbeat();
    this.clearFallback();
  }

  private clearFallback(): void {
    window.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
    const fallback = this.fallbackSocket;
    this.fallbackSocket = null;
    fallback?.close();
  }

  private clearHeartbeat(): void {
    window.clearTimeout(this.heartbeatTimer);
    window.clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    this.pingSentAtMs = undefined;
    this.clearProbe();
  }

  private disconnect(socket: RemoteChannel, message: string | Error): void {
    if (this.socket !== socket) return;
    const probe = this.probeSocket;
    this.probeSocket = null;
    const fallback = this.fallbackSocket;
    this.fallbackSocket = null;
    this.clearSocketTimers();
    this.socket = null;
    this.options.onSocket(null);
    socket.close();
    // Selecting a route before synchronization is not loss of a live session.
    if (!this.synchronized && !this.http && this.options.httpFallback &&
        !this.stopped && navigator.onLine) {
      this.http = true;
      if (fallback && fallback.readyState < 2) this.attach(fallback);
      else this.connect();
      return;
    }
    fallback?.close();
    this.options.onDisconnect(typeof message === 'string' ? new Error(message) : message);
    window.clearTimeout(this.reconnectTimer);
    if (!this.stopped && navigator.onLine) {
      if (probe && probe.readyState < 2) {
        this.http = true;
        this.attach(probe);
        return;
      }
      if (!this.http && this.options.httpFallback) {
        this.http = true;
        this.connect();
        return;
      }
      const ceiling = document.visibilityState === 'visible' ? 5000 : 15_000;
      const delay = Math.min(250 * 2 ** Math.min(this.failures++, 6), ceiling);
      this.reconnectTimer = window.setTimeout(this.connect, delay);
    }
    probe?.close();
  }

  private clearProbe(): void {
    window.clearTimeout(this.probeTimer);
    window.clearTimeout(this.probeDeadline);
    this.probeTimer = this.probeDeadline = undefined;
    const probe = this.probeSocket;
    this.probeSocket = null;
    probe?.close();
  }

  private probeHttpRoute = (): void => {
    this.probeTimer = undefined;
    const original = this.socket;
    if (!this.options.httpFallback || !this.synchronized || this.probeSocket ||
        !original || this.pongTimer === undefined || document.visibilityState !== 'visible') return;
    const probe = new HttpChannel(this.options.httpFallback);
    this.probeSocket = probe;
    const metadata: Message[] = [];
    this.probeDeadline = window.setTimeout(() => this.clearProbe(), 6000);
    probe.addEventListener('open', () => {
      if (this.probeSocket === probe) probe.send(JSON.stringify({ type: 'ping' }));
    });
    probe.addEventListener('error', () => {
      if (this.probeSocket === probe) this.clearProbe();
    });
    probe.addEventListener('message', event => {
      if (this.probeSocket !== probe || this.socket !== original || this.stopped) return;
      let message: Message;
      try { message = JSON.parse(String((event as MessageEvent).data)) as Message; }
      catch { return; }
      if (message.type === 'hello' || message.type === 'bridge.status') metadata.push(message);
      if (message.type !== 'pong') return;
      // Only a responding replacement may retire the old channel. Actions stay on
      // the original until this handover; normal sync/replay gates sending again.
      this.disconnect(original, 'Restoring the Remote connection...');
      for (const item of metadata) this.options.onMessage(item);
    });
  };

  private ping = (): void => {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pongTimer !== undefined ||
        document.visibilityState !== 'visible') return;
    this.clearProbe();
    window.clearTimeout(this.heartbeatTimer);
    this.probeTimer = window.setTimeout(this.probeHttpRoute, 2000);
    this.pongTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') { this.clearHeartbeat(); return; }
      // A suspended event loop must get a fresh probe instead of an expired timeout.
      if (this.pingSentAtMs !== undefined && Date.now() - this.pingSentAtMs > this.pongTimeoutMs + 5000) {
        this.clearHeartbeat();
        this.ping();
        return;
      }
      this.disconnect(socket, 'Remote heartbeat timed out. Reconnecting...');
    }, this.pongTimeoutMs);
    try {
      this.pingSentAtMs = Date.now();
      socket.send(JSON.stringify({ type: 'ping' }));
    } catch {
      this.disconnect(socket, 'Remote connection lost. Reconnecting...');
    }
  };

  private markAlive(): void {
    window.clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    window.clearTimeout(this.heartbeatTimer);
    this.clearProbe();
    if (document.visibilityState === 'visible' && this.socket?.readyState === WebSocket.OPEN) {
      this.heartbeatTimer = window.setTimeout(() => this.ping(), this.heartbeatIntervalMs);
    }
  }

  private online = (): void => {
    this.failures = 0;
    this.recover();
  };

  private networkChanged = (): void => {
    this.failures = 0;
    this.clearHeartbeat();
    this.recover();
  };

  private offline = (): void => {
    window.clearTimeout(this.reconnectTimer);
    if (this.socket) this.disconnect(this.socket, 'Network is offline.');
  };

  private recover = (event?: Event): void => {
    if (document.visibilityState !== 'visible') {
      this.suspended = true;
      window.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.clearHeartbeat();
      return;
    }
    const resumed = this.suspended || event?.type === 'pageshow' && (event as PageTransitionEvent).persisted;
    this.suspended = false;
    if (resumed) this.clearHeartbeat();
    if (!this.socket) this.connect();
    else {
      // Focus/pageshow during normal use must not shorten or extend a handshake.
      if (resumed && !this.synchronized) this.armHandshake(this.socket);
      this.ping();
    }
  };
}
