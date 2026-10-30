import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import webPush from 'web-push';
import { asyncQuestions, questionItemId } from '../shared/async-user-input.js';
import type { PushSubscription, VapidKeys } from 'web-push';

interface PushState {
  keys: VapidKeys;
  subscriptions: PushSubscription[];
  watchedThreads: string[];
}

interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  threadId?: string;
}

type ThreadReader = (threadId: string) => Promise<unknown>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return null;
}

function truncateReply(value: string, limit = 100): string {
  const characters = Array.from(value.trim());
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
}

function replyText(params: Record<string, unknown>): string | null {
  const turn = recordValue(params.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const phase of ['final_answer', null]) {
    for (const item of [...items].reverse()) {
      const candidate = recordValue(item);
      if (candidate?.type !== 'agentMessage' || (candidate.phase ?? null) !== phase) continue;
      const text = firstText(candidate.text);
      if (text) return truncateReply(text);
    }
  }
  return null;
}

function threadTitle(value: unknown): string | null {
  const thread = recordValue(value);
  return firstText(thread?.name, thread?.preview);
}

function subscriptionValue(value: unknown): PushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PushSubscription>;
  if (typeof candidate.endpoint !== 'string' || !candidate.keys) return null;
  try {
    const endpoint = new URL(candidate.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return null;
    const { p256dh, auth } = candidate.keys;
    if (typeof p256dh !== 'string' || typeof auth !== 'string'
      || !/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)
      || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) return null;
    return {
      endpoint: candidate.endpoint,
      keys: { p256dh, auth },
      ...(typeof candidate.expirationTime === 'number' ? { expirationTime: candidate.expirationTime } : {})
    };
  } catch { return null; }
}

export class PushNotifications {
  private readonly file: string;
  private readonly state: PushState;
  private readonly subscriptions: Map<string, PushSubscription>;
  private readonly watchedThreads: Set<string>;

  constructor(dataDir: string, private readonly subject: string, private readonly readThread?: ThreadReader) {
    this.file = path.join(dataDir, 'web-push.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PushState;
    } else {
      this.state = { keys: webPush.generateVAPIDKeys(), subscriptions: [], watchedThreads: [] };
    }
    this.subscriptions = new Map(this.state.subscriptions.map(subscription => [subscription.endpoint, subscription]));
    this.watchedThreads = new Set(this.state.watchedThreads);
    if (!fs.existsSync(this.file)) this.save();
  }

  get publicKey(): string {
    return this.state.keys.publicKey;
  }

  private save(): void {
    this.state.subscriptions = [...this.subscriptions.values()];
    this.state.watchedThreads = [...this.watchedThreads];
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  subscribe(value: unknown): boolean {
    const subscription = subscriptionValue(value);
    if (!subscription) return false;
    this.subscriptions.set(subscription.endpoint, subscription);
    this.save();
    return true;
  }

  status(endpoint: string): boolean {
    return this.subscriptions.has(endpoint);
  }

  unsubscribe(endpoint: string): void {
    if (this.subscriptions.delete(endpoint)) this.save();
  }

  // The caller admits only ordinary persisted chats, never side chats or subagents.
  watch(threadId: string): void {
    if (!threadId || this.watchedThreads.has(threadId)) return;
    this.watchedThreads.add(threadId);
    this.save();
  }

  private async conversationTitle(threadId: string, params: Record<string, unknown>): Promise<string> {
    const fromEvent = threadTitle(params.thread) ?? firstText(params.threadName, params.name);
    if (fromEvent) return truncateReply(fromEvent);
    if (this.readThread) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => this.readThread!(threadId)),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })
        ]);
        const fromNative = threadTitle(recordValue(result)?.thread);
        if (fromNative) return truncateReply(fromNative);
      } catch { /* Title metadata must not prevent status delivery. */ }
      finally { clearTimeout(timer); }
    }
    return 'Codex';
  }

  async notifyTurn(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const turn = params.turn as { id?: string; status?: string } | undefined;
    if (!this.subscriptions.size || !this.watchedThreads.has(threadId) || !turn?.id) return;
    const status = turn.status === 'completed' ? '\u4efb\u52a1\u5df2\u5b8c\u6210'
      : turn.status === 'interrupted' ? '\u4efb\u52a1\u5df2\u505c\u6b62'
      : turn.status === 'failed' ? '\u4efb\u52a1\u6267\u884c\u5931\u8d25' : null;
    if (status) {
      const title = await this.conversationTitle(threadId, params);
      const reply = turn.status === 'completed' ? replyText(params) : null;
      await this.notify({
        title, body: reply ? `${status}：${reply}` : status, tag: `codex-turn-${threadId}`,
        url: `/?thread=${encodeURIComponent(threadId)}`, threadId
      });
    }
  }

  async notifyApproval(params: Record<string, unknown>, method?: string): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (!this.subscriptions.size || !this.watchedThreads.has(threadId)) return;
    const questions = method === 'item/tool/requestUserInput' && Array.isArray(params.questions)
      ? params.questions.map(value => firstText(recordValue(value)?.question)).filter(Boolean).join('；') : null;
    await this.notify({
      title: await this.conversationTitle(threadId, params),
      body: method === 'item/tool/requestUserInput' ? `需要你回答${questions ? `：${truncateReply(questions)}` : ''}` : '任务需要你的确认',
      tag: `${method === 'item/tool/requestUserInput' ? 'codex-question' : 'codex-approval'}-${threadId}`, url: `/?thread=${encodeURIComponent(threadId)}`, threadId
    });
  }

  /** Only newly pending IDs from live native events are eligible, never history hydration. */
  async notifyQuestions(params: Record<string, unknown>, newIds: string[]): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (!this.subscriptions.size || !this.watchedThreads.has(threadId) || !Array.isArray(newIds) || !newIds.length) return;
    const ids = new Set(newIds);
    const turn = recordValue(params.turn);
    const items = params.item ? [params.item] : Array.isArray(turn?.items) ? turn.items : [];
    const titles = items.flatMap(value => {
      const item = recordValue(value);
      if (item?.type !== 'agentMessage' || typeof item.id !== 'string') return [];
      return asyncQuestions(item.questions).filter((_, index) => ids.has(questionItemId(item.id as string, index)))
        .map(question => question.title);
    });
    if (!titles.length) return;
    console.debug('[async-questions] notification requested', { count: titles.length });
    await this.notify({
      title: await this.conversationTitle(threadId, params), body: `需要你回答：${truncateReply(titles.join('；'))}`,
      tag: `codex-question-${threadId}`, url: `/?thread=${encodeURIComponent(threadId)}`, threadId
    });
  }

  private async send(subscription: PushSubscription, payload: NotificationPayload): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      const sending = webPush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject: this.subject, ...this.state.keys },
        timeout: 8000, TTL: 300, urgency: 'high', contentEncoding: 'aes128gcm'
      });
      await Promise.race([
        sending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Push delivery timed out.')), 8000);
        })
      ]);
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | null)?.statusCode;
      if (statusCode === 404 || statusCode === 410) this.unsubscribe(subscription.endpoint);
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }

  private async notify(payload: NotificationPayload): Promise<void> {
    await Promise.allSettled([...this.subscriptions.values()].map(async subscription => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this.status(subscription.endpoint)) return;
        try { await this.send(subscription, payload); return; }
        catch (error) {
          const status = (error as { statusCode?: number })?.statusCode;
          if (attempt === 2 || status !== undefined && status !== 429 && status < 500) {
            console.warn('[push] notification delivery failed', { attempt: attempt + 1, status: status ?? 'network' });
            return;
          }
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, attempt === 0 ? 1000 : 4000);
            timer.unref?.();
          });
        }
      }
    }));
  }

  async test(endpoint: string): Promise<'sent' | 'missing' | 'failed'> {
    const subscription = this.subscriptions.get(endpoint);
    if (!subscription) return 'missing';
    try {
      await this.send(subscription, {
        title: 'Codex', body: '\u901a\u77e5\u5df2\u8fde\u901a', tag: 'codex-test', url: '/'
      });
      return 'sent';
    } catch { return 'failed'; }
  }

  router(): Router {
    const router = Router();
    router.get('/public-key', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ publicKey: this.publicKey });
    });
    router.post('/status', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ enabled: typeof req.body?.endpoint === 'string' && this.status(req.body.endpoint) });
    });
    router.post('/subscription', (req, res) => {
      if (!this.subscribe(req.body?.subscription)) {
        res.status(400).json({ error: 'A valid browser push subscription is required.' });
        return;
      }
      res.json({ ok: true });
    });
    router.delete('/subscription', (req, res) => {
      if (typeof req.body?.endpoint === 'string') this.unsubscribe(req.body.endpoint);
      res.json({ ok: true });
    });
    router.post('/test', async (req, res) => {
      const result = await this.test(typeof req.body?.endpoint === 'string' ? req.body.endpoint : '');
      if (result === 'missing') res.status(404).json({ error: 'Enable notifications on this device first.' });
      else if (result === 'failed') res.status(502).json({ error: 'Push delivery failed. Please retry.' });
      else res.json({ ok: true });
    });
    return router;
  }
}
