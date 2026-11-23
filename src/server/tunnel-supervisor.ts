export interface TunnelChild {
  exited: Promise<void>;
  stop: () => Promise<void>;
}

const REBUILD_AFTER_UNHEALTHY_MS = 20_000;

interface SupervisorOptions {
  start: () => Promise<TunnelChild>;
  ready: () => Promise<boolean>;
  egressReady: () => Promise<boolean>;
  network: () => string;
  log: (message: string) => void;
}

export class TunnelSupervisor {
  private stopped = false;
  private child: TunnelChild | null = null;
  private running = false;
  private startedAt = 0;
  private unhealthySince: number | null = null;
  private nextStartAt = 0;
  private cooldownUntil = 0;
  private crashes = 0;
  private changed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: SupervisorOptions) {}

  networkChanged(): void {
    this.changed = true;
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  async run(): Promise<void> {
    let network = this.options.network();
    try {
      while (!this.stopped) {
        const current = this.options.network();
        if (this.changed || current !== network) {
          network = current;
          this.changed = false;
          this.nextStartAt = 0;
          this.cooldownUntil = 0;
          this.options.log('Network changed; checking tunnel readiness.');
        }
        if (!this.running && Date.now() >= this.nextStartAt) {
          try {
            const child = await this.options.start();
            this.child = child;
            this.running = true;
            this.startedAt = Date.now();
            this.unhealthySince = null;
            void child.exited.then(() => {
              if (this.child !== child) return;
              this.running = false;
              this.nextStartAt = Date.now() + Math.min(1000 * 2 ** this.crashes++, 5000);
              this.options.log('Tunnel exited; scheduling recovery.');
              this.wake?.();
            });
          } catch {
            this.nextStartAt = Date.now() + 5000;
            this.options.log('Tunnel launch failed; retrying in five seconds.');
          }
        }
        if (this.running) {
          const ready = await this.options.ready();
          if (this.stopped) break;
          if (ready) {
            this.unhealthySince = null;
            this.crashes = 0;
          } else {
            this.unhealthySince ??= Date.now();
            // Keep surviving HA connections and give a new process time to register.
            if (Date.now() - this.startedAt >= 8000 &&
                Date.now() - this.unhealthySince >= REBUILD_AFTER_UNHEALTHY_MS &&
                Date.now() >= this.cooldownUntil && await this.options.egressReady()) {
              // A connection may have recovered during the bounded outbound probe.
              if (!this.stopped && this.running && !await this.options.ready()) {
                this.options.log('All tunnel connections unavailable; rebuilding on the available network.');
                const child = this.child;
                this.child = null;
                await child?.stop();
                this.running = false;
                this.nextStartAt = 0;
                this.cooldownUntil = Date.now() + 15_000;
                continue;
              }
            }
          }
        }
        if (!this.stopped) await new Promise<void>(resolve => {
          this.wake = () => { clearTimeout(this.timer); this.wake = undefined; resolve(); };
          const wait = this.changed ? 0 : this.running ? 2000
            : Math.max(0, Math.min(2000, this.nextStartAt - Date.now()));
          this.timer = setTimeout(this.wake, wait);
        });
      }
    } finally {
      clearTimeout(this.timer);
      const child = this.child;
      this.child = null;
      await child?.stop();
    }
  }
}
