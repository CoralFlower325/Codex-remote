import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as recurrence from 'rrule';

import type {
  Automation,
  AutomationMethod,
  AutomationRun
} from '../shared/automation-schedule.js';
import type { ClientRpcMethod } from '../shared/protocol.js';

const { rrulestr } = (Reflect.get(recurrence, 'default') as typeof recurrence | undefined) ?? recurrence;
const MAX_HISTORY = 500;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;

type Rpc = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;
type Ready = () => boolean;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function nextRun(rule: string, from = new Date()): number | null {
  try {
    const parsed = rrulestr(rule);
    return parsed.after(from, false)?.getTime() ?? null;
  } catch {
    return null;
  }
}

export class RemoteAutomations {
  private readonly file: string;
  private readonly historyFile: string;
  private items: Automation[] = [];
  private history: AutomationRun[] = [];
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryAt = 0;
  private consecutiveFailures = 0;

  constructor(
    dataDir: string,
    private readonly rpc: Rpc,
    private readonly ready: Ready = () => true
  ) {
    this.file = path.join(dataDir, 'automations.json');
    this.historyFile = path.join(dataDir, 'automation-runs.json');
    this.load();
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 1000).unref();
  }

  async request(method: AutomationMethod, params?: unknown): Promise<unknown> {
    const input = record(params);
    switch (method) {
      case 'list':
        return { items: this.items };
      case 'readHistory':
        return { items: this.history.slice(0, Math.min(MAX_HISTORY, Number(input.limit) || 200)) };
      case 'create':
        return this.create(input);
      case 'update':
        return this.update(input);
      case 'delete':
        return this.delete(input);
      case 'runNow':
        return this.runNow(input);
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  wake(): void {
    this.clearRetry();
    void this.tick();
  }

  private create(input: Record<string, unknown>): { item: Automation } {
    const now = Date.now();
    const item: Automation = {
      ...(input as unknown as Automation),
      id: randomUUID(),
      status: input.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.status === 'PAUSED' ? null : nextRun(String(input.rrule || ''))
    };
    this.items = [item, ...this.items];
    this.save();
    return { item };
  }

  private update(input: Record<string, unknown>): { item: Automation } {
    const id = String(input.id || '');
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error('自动任务不存在，请刷新列表。');
    const current = this.items[index]!;
    const next: Automation = {
      ...current,
      ...(input as Partial<Automation>),
      id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      nextRunAt: input.status === 'PAUSED' ? null : nextRun(String(input.rrule ?? current.rrule))
    };
    this.items = this.items.map((item, itemIndex) => itemIndex === index ? next : item);
    this.save();
    return { item: next };
  }

  private delete(input: Record<string, unknown>): { success: true } {
    const id = String(input.id || '');
    this.items = this.items.filter(item => item.id !== id);
    this.save();
    return { success: true };
  }

  private async runNow(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(input.id || '');
    const item = this.items.find(candidate => candidate.id === id);
    if (!item) throw new Error('自动任务不存在，请刷新列表。');
    const result = await this.execute(item, true);
    return { success: true, ...result };
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now < this.retryAt) return;
    if (!this.ready()) {
      this.deferRetry();
      return;
    }
    const due = this.items.filter(item => item.status === 'ACTIVE' &&
      item.nextRunAt !== null && item.nextRunAt <= now && !this.running.has(item.id));
    for (const item of due) {
      await this.execute(item, false).then(() => this.clearRetry()).catch(() => this.deferRetry());
    }
  }

  private async execute(item: Automation, manual: boolean): Promise<Record<string, unknown>> {
    if (this.running.has(item.id)) throw new Error('任务正在运行，请等待本次结果。');
    this.running.add(item.id);
    const startedAt = Date.now();
    const claim: AutomationRun = {
      automationId: item.id,
      threadId: item.targetThreadId || '',
      status: 'claimed',
      createdAt: startedAt
    };
    this.history = [claim, ...this.history].slice(0, MAX_HISTORY);
    if (!manual) {
      // Persist the claim and advance the schedule before any write leaves the
      // process. A crash leaves an auditable claim and never auto-replays an
      // occurrence whose App Server outcome is uncertain.
      this.items = this.items.map(candidate => candidate.id === item.id ? {
        ...candidate,
        nextRunAt: candidate.status === 'ACTIVE'
          ? nextRun(candidate.rrule, new Date(startedAt + 1000)) : null
      } : candidate);
    }
    this.save();
    try {
      let threadId = item.targetThreadId;
      if (threadId) {
        await this.rpc('thread/resume', { threadId });
      }
      if (!threadId) {
        const cwd = item.cwds?.[0];
        const projectId = item.target?.type === 'project' ? item.target.projectId
          : item.target?.type === 'projectless' ? null : undefined;
        const created = await this.rpc('thread/start', {
          ...(cwd ? { cwd } : {}),
          ...(projectId === undefined ? {} : { projectId }),
          ...(item.model ? { model: item.model } : {})
        }) as { thread: { id: string } };
        threadId = created.thread.id;
      }
      await this.rpc('turn/start', {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: item.prompt }],
        ...(item.model ? { model: item.model } : {}),
        ...(item.reasoningEffort ? { effort: item.reasoningEffort } : {})
      });
      claim.threadId = threadId;
      claim.status = 'started';
      this.items = this.items.map(candidate => {
        if (candidate.id !== item.id) return candidate;
        const updated: Automation = {
          ...candidate,
          lastRunAt: startedAt,
          updatedAt: manual ? candidate.updatedAt : startedAt
        };
        if (candidate.kind === 'heartbeat') updated.targetThreadId = threadId;
        return updated;
      });
      this.save();
      return { threadId, run: claim };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      claim.status = `failed: ${message.slice(0, 500)}`;
      this.save();
      throw error;
    } finally {
      this.running.delete(item.id);
    }
  }

  private deferRetry(): void {
    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 8);
    const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (this.consecutiveFailures - 1));
    this.retryAt = Date.now() + delay;
  }

  private clearRetry(): void {
    this.consecutiveFailures = 0;
    this.retryAt = 0;
  }

  private load(): void {
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(stored)) {
        this.items = stored.filter(item => record(item).id).map(item => ({
          ...item,
          nextRunAt: item.status === 'ACTIVE' && item.nextRunAt
            ? item.nextRunAt : item.status === 'ACTIVE' ? nextRun(item.rrule) : null
        }));
      }
    } catch { /* A missing or damaged store starts empty. */ }
    try {
      const stored = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (Array.isArray(stored)) this.history = stored.slice(0, MAX_HISTORY);
    } catch { /* History is optional. */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const atomic = (file: string, value: unknown) => {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, file);
    };
    atomic(this.file, this.items);
    atomic(this.historyFile, this.history);
  }
}
