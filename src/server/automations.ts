import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type ErrorRequestHandler } from 'express';
import {
  isAutomationSchedule, nextAutomationRun,
  type Automation, type AutomationRunRecord, type AutomationSchedule
} from '../shared/automation-schedule.js';
import { asyncRoute } from './http-route.js';

// Remote-side automation scheduler. The native App Server protocol has no
// automation surface, so definitions live in Remote's private data and each
// run is dispatched through the existing Desktop bridge with the same native
// calls the client makes (thread/start, then turn/start). A run whose outcome
// cannot be proven is recorded as `unknown` and never replayed; occurrences
// missed while the bridge is offline collapse into a single run when it
// returns, mirroring the never-replay rule for uncertain actions.

export type AutomationBridgeRequest = (method: string, params: unknown) => Promise<unknown>;

const MAX_AUTOMATIONS = 100;
const MAX_RUNS_KEPT = 20;
const NAME_LIMIT = 80;
const PROMPT_LIMIT = 8000;

interface AutomationState { automations: Automation[] }

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= limit ? text : null;
}

function optionalText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return boundedText(value, limit);
}

function isRunRecord(value: unknown): value is AutomationRunRecord {
  const record = recordValue(value);
  return Boolean(record) && typeof record?.at === 'number'
    && (record?.kind === 'scheduled' || record?.kind === 'manual')
    && (record?.status === 'started' || record?.status === 'failed' || record?.status === 'unknown')
    && (record?.threadId === undefined || typeof record?.threadId === 'string')
    && (record?.error === undefined || typeof record?.error === 'string');
}

function isAutomation(value: unknown): value is Automation {
  const record = recordValue(value);
  if (!record) return false;
  return typeof record.id === 'string' && record.id.length > 0
    && typeof record.name === 'string' && typeof record.prompt === 'string'
    && (record.projectId === null || typeof record.projectId === 'string')
    && (record.cwd === null || typeof record.cwd === 'string')
    && (record.model === null || typeof record.model === 'string')
    && (record.effort === null || typeof record.effort === 'string')
    && (record.status === 'active' || record.status === 'paused')
    && isAutomationSchedule(record.schedule)
    && (record.nextRunAt === null || typeof record.nextRunAt === 'number')
    && (record.lastRunAt === null || typeof record.lastRunAt === 'number')
    && (record.lastThreadId === null || typeof record.lastThreadId === 'string')
    && typeof record.createdAt === 'number' && typeof record.updatedAt === 'number'
    && Array.isArray(record.runs) && record.runs.every(isRunRecord);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/** A JSON-RPC error response proves the host rejected the call; anything else
 * (socket drop, timeout) leaves the outcome unknown. */
function isDefiniteRejection(error: unknown): boolean {
  const record = recordValue(error);
  return typeof record?.code === 'number' || typeof recordValue(record?.error)?.code === 'number';
}

export class Automations {
  private readonly file: string;
  private readonly automations = new Map<string, Automation>();
  private readonly dispatching = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unavailable = false;
  private persistenceFailed = false;

  constructor(
    dataDir: string,
    private readonly request: AutomationBridgeRequest,
    private readonly isBridgeReady: () => boolean,
    private readonly now: () => number = Date.now
  ) {
    this.file = path.join(dataDir, 'automations.json');
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw new Error('Automation state too large');
        const stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AutomationState;
        if (!stored || !Array.isArray(stored.automations) || !stored.automations.every(isAutomation)) {
          throw new Error('Invalid automation state');
        }
        for (const automation of stored.automations) this.automations.set(automation.id, automation);
      }
    } catch { this.disable(); }
  }

  private disable(): void {
    this.unavailable = true;
    console.warn('[automations] Automations unavailable; private state was preserved. Check storage and restart after repair.');
  }

  private save(): void {
    const state: AutomationState = { automations: [...this.automations.values()] };
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.persistenceFailed = false;
    } catch (error) {
      this.persistenceFailed = true;
      console.warn('[automations] Automation persistence failed; scheduling is paused until storage recovers.');
      throw error;
    }
  }

  list(): Automation[] {
    return [...this.automations.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Automation | undefined {
    return this.automations.get(id);
  }

  create(input: Record<string, unknown>): Automation {
    if (this.automations.size >= MAX_AUTOMATIONS) throw new Error('自动任务数量已达上限。');
    const name = boundedText(input.name, NAME_LIMIT);
    const prompt = boundedText(input.prompt, PROMPT_LIMIT);
    if (!name) throw new Error('请填写自动任务名称（80 字以内）。');
    if (!prompt) throw new Error('请填写提示词（8000 字以内）。');
    if (!isAutomationSchedule(input.schedule)) throw new Error('计划设置不正确。');
    const at = this.now();
    const automation: Automation = {
      id: randomUUID(),
      name,
      prompt,
      projectId: optionalText(input.projectId, 512),
      cwd: optionalText(input.cwd, 4096),
      model: optionalText(input.model, 256),
      effort: optionalText(input.effort, 64),
      status: input.status === 'paused' ? 'paused' : 'active',
      schedule: input.schedule,
      nextRunAt: null,
      lastRunAt: null,
      lastThreadId: null,
      createdAt: at,
      updatedAt: at,
      runs: []
    };
    automation.nextRunAt = automation.status === 'active'
      ? nextAutomationRun(automation.schedule, at) : null;
    this.automations.set(automation.id, automation);
    try { this.save(); } catch (error) { this.automations.delete(automation.id); throw error; }
    return automation;
  }

  update(id: string, input: Record<string, unknown>): Automation {
    const automation = this.automations.get(id);
    if (!automation) throw new Error('自动任务不存在。');
    const next: Automation = { ...automation };
    if ('name' in input) {
      const name = boundedText(input.name, NAME_LIMIT);
      if (!name) throw new Error('请填写自动任务名称（80 字以内）。');
      next.name = name;
    }
    if ('prompt' in input) {
      const prompt = boundedText(input.prompt, PROMPT_LIMIT);
      if (!prompt) throw new Error('请填写提示词（8000 字以内）。');
      next.prompt = prompt;
    }
    if ('projectId' in input) next.projectId = optionalText(input.projectId, 512);
    if ('cwd' in input) next.cwd = optionalText(input.cwd, 4096);
    if ('model' in input) next.model = optionalText(input.model, 256);
    if ('effort' in input) next.effort = optionalText(input.effort, 64);
    let scheduleChanged = false;
    if ('schedule' in input) {
      if (!isAutomationSchedule(input.schedule)) throw new Error('计划设置不正确。');
      next.schedule = input.schedule;
      scheduleChanged = true;
    }
    if ('status' in input) {
      if (input.status !== 'active' && input.status !== 'paused') throw new Error('状态不正确。');
      next.status = input.status;
    }
    next.updatedAt = this.now();
    if (next.status === 'paused') next.nextRunAt = null;
    else if (scheduleChanged || automation.status !== 'active' || next.nextRunAt === null) {
      next.nextRunAt = nextAutomationRun(next.schedule, next.updatedAt);
    }
    this.automations.set(id, next);
    try { this.save(); } catch (error) { this.automations.set(id, automation); throw error; }
    return next;
  }

  remove(id: string): boolean {
    const automation = this.automations.get(id);
    if (!automation) return false;
    this.automations.delete(id);
    try { this.save(); } catch (error) { this.automations.set(id, automation); throw error; }
    return true;
  }

  /** Dispatch one run now. Never retries: an unprovable outcome is recorded
   * as `unknown` and left for the user to inspect. */
  async runNow(id: string, kind: 'scheduled' | 'manual' = 'manual'): Promise<Automation> {
    const automation = this.automations.get(id);
    if (!automation) throw new Error('自动任务不存在。');
    if (this.dispatching.has(id)) throw new Error('该自动任务正在执行上一次触发。');
    this.dispatching.add(id);
    const startedAt = this.now();
    let threadId: string | null = null;
    let record: AutomationRunRecord;
    try {
      const started = recordValue(await this.request('thread/start', {
        ...(automation.cwd ? { cwd: automation.cwd } : {}),
        ...(automation.projectId ? { projectId: automation.projectId } : {}),
        ...(automation.model ? { model: automation.model } : {})
      }));
      threadId = typeof recordValue(started?.thread)?.id === 'string'
        ? recordValue(started?.thread)!.id as string : null;
      if (!threadId) throw new Error('主机未返回新会话。');
      await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: automation.prompt, text_elements: [] }],
        ...(automation.model ? { model: automation.model } : {}),
        ...(automation.effort ? { effort: automation.effort } : {})
      });
      record = { at: startedAt, kind, status: 'started', threadId };
    } catch (error) {
      record = {
        at: startedAt, kind,
        status: !threadId && isDefiniteRejection(error) ? 'failed' : 'unknown',
        ...(threadId ? { threadId } : {}),
        error: errorText(error)
      };
    } finally {
      this.dispatching.delete(id);
    }
    const current = this.automations.get(id);
    if (current) {
      current.lastRunAt = startedAt;
      if (threadId) current.lastThreadId = threadId;
      current.runs = [record, ...current.runs].slice(0, MAX_RUNS_KEPT);
      current.updatedAt = this.now();
      try { this.save(); } catch { /* The run already happened; keep it in memory. */ }
    }
    return this.automations.get(id) ?? automation;
  }

  /** Advance every due automation once. Missed occurrences collapse: the
   * schedule advances past `now` after a single dispatch. */
  async tick(): Promise<void> {
    if (this.unavailable || this.persistenceFailed || !this.isBridgeReady()) return;
    const now = this.now();
    for (const automation of this.list()) {
      if (automation.status !== 'active' || automation.nextRunAt === null) continue;
      if (automation.nextRunAt > now || this.dispatching.has(automation.id)) continue;
      const scheduledFor = automation.nextRunAt;
      await this.runNow(automation.id, 'scheduled');
      const current = this.automations.get(automation.id);
      if (current && current.status === 'active') {
        let next = scheduledFor;
        do { next = nextAutomationRun(current.schedule, next); } while (next <= this.now());
        current.nextRunAt = next;
        current.updatedAt = this.now();
        try { this.save(); } catch { /* Next tick re-derives from the stale value. */ }
      }
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  router(): Router {
    const router = Router();
    router.use((_req, res, next) => {
      if (this.unavailable) {
        res.status(503).json({ error: '自动任务暂不可用，请在主机检查并恢复私有数据后重启 Remote。现有数据未重置。' });
        return;
      }
      if (this.persistenceFailed) {
        try { this.save(); }
        catch {
          res.status(503).json({ error: '自动任务数据保存失败，调度已暂停。请检查主机存储后重试，现有数据未重置。' });
          return;
        }
      }
      next();
    });
    router.get('/', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ automations: this.list() });
    });
    router.post('/', (req, res) => {
      try {
        res.json({ automation: this.create(recordValue(req.body) ?? {}) });
      } catch (error) { res.status(400).json({ error: errorText(error) }); }
    });
    router.patch('/:id', (req, res) => {
      try {
        res.json({ automation: this.update(req.params.id, recordValue(req.body) ?? {}) });
      } catch (error) {
        res.status(error instanceof Error && error.message === '自动任务不存在。' ? 404 : 400)
          .json({ error: errorText(error) });
      }
    });
    router.delete('/:id', (req, res) => {
      if (!this.remove(req.params.id)) { res.status(404).json({ error: '自动任务不存在。' }); return; }
      res.json({ ok: true });
    });
    router.post('/:id/run', asyncRoute(async (req, res) => {
      if (!this.isBridgeReady()) {
        res.status(503).json({ error: '桌面端未连接，无法执行自动任务。' });
        return;
      }
      try {
        res.json({ automation: await this.runNow(String(req.params.id ?? '')) });
      } catch (error) {
        res.status(error instanceof Error && error.message === '自动任务不存在。' ? 404 : 409)
          .json({ error: errorText(error) });
      }
    }));
    const storageError: ErrorRequestHandler = (error, _req, res, next) => {
      if (!this.persistenceFailed) { next(error); return; }
      res.status(503).json({ error: '自动任务数据保存失败，调度已暂停。请检查主机存储后重试，现有数据未重置。' });
    };
    router.use(storageError);
    return router;
  }
}

export type { Automation, AutomationSchedule };
