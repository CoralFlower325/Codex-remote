import { Router } from 'express';
import {
  validAutomationRule, type Automation, type AutomationList, type AutomationMethod, type AutomationRun
} from '../shared/automation-schedule.js';
import { asyncRoute } from './http-route.js';

export type AutomationBridgeRequest = (method: AutomationMethod, params?: unknown) => Promise<unknown>;

class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('任务设置不正确。');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new InputError(`${label}不能为空且最多 ${limit} 字。`);
  }
  return value.trim();
}

// A projection of native fields only. There is no Remote store or scheduler.
export class Automations {
  private readonly acting = new Set<string>();
  constructor(private readonly request: AutomationBridgeRequest) {}

  private async nativeList(): Promise<Automation[]> {
    const result = record(await this.request('list'));
    if (!Array.isArray(result.items)) throw new Error('Desktop 自动任务接口返回了无法识别的数据。');
    return result.items as Automation[];
  }

  async list(): Promise<AutomationList> {
    const automations = await this.nativeList();
    const history = record(await this.request('readHistory', { limit: 200 }));
    if (!Array.isArray(history.items)) throw new Error('Desktop 自动任务历史返回了无法识别的数据。');
    // Do not expose archived conversation bodies just to render a run link.
    const runs = history.items.map((entry: AutomationRun) => ({
      automationId: entry.automationId, threadId: entry.threadId,
      status: entry.status, createdAt: entry.createdAt
    }));
    return { automations, runs, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  private async current(id: string, version?: unknown): Promise<Automation> {
    const current = (await this.nativeList()).find(item => item.id === id);
    if (!current) throw new InputError('自动任务不存在，请刷新列表。', 404);
    if (version !== undefined && version !== current.updatedAt) {
      throw new InputError('任务已在其他窗口修改，请刷新后重试。', 409);
    }
    return current;
  }

  private settings(input: Record<string, unknown>, current?: Automation): Record<string, unknown> {
    const next = { ...current, ...input };
    const name = current && (!('name' in input) || input.name === current.name)
      ? current.name : text(next.name, 80, '名称');
    const prompt = current && (!('prompt' in input) || input.prompt === current.prompt)
      ? current.prompt : text(next.prompt, 8000, '提示词');
    const rrule = current && (!('rrule' in input) || input.rrule === current.rrule)
      ? current.rrule : text(next.rrule, 4096, '计划');
    if ((!current || rrule !== current.rrule) && !validAutomationRule(rrule)) {
      throw new InputError('计划格式不正确。');
    }
    if (!['ACTIVE', 'PAUSED'].includes(String(next.status))) throw new InputError('状态不正确。');
    const model = next.model == null || next.model === '' ? null : text(next.model, 256, '模型');
    const reasoningEffort = next.reasoningEffort == null || next.reasoningEffort === '' ? null
      : text(next.reasoningEffort, 64, '推理强度');
    const common = { name, prompt, rrule, status: next.status, model, reasoningEffort,
      ...(current ? { id: current.id, notificationPolicy: current.notificationPolicy ?? null } : {}) };
    if (current?.kind === 'heartbeat') {
      return { ...common, kind: 'heartbeat', targetThreadId: current.targetThreadId };
    }
    const environment = next.executionEnvironment ?? 'local';
    if (environment !== 'local' && environment !== 'worktree') throw new InputError('执行环境不正确。');
    const projectId = 'projectId' in input ? input.projectId
      : current?.target?.type === 'project' ? current.target.projectId : null;
    if (projectId !== null && projectId !== '') text(projectId, 512, '项目');
    return { ...common, kind: 'cron', executionEnvironment: environment,
      ...(!('projectId' in input) && current?.target === null && current.cwds
        ? { cwds: current.cwds } : { projectId: projectId || null }),
      ...(current ? { localEnvironmentConfigPath: current.localEnvironmentConfigPath ?? null,
        autoArchive: current.autoArchive ?? false } : {}) };
  }

  private async act<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.acting.has(key)) throw new InputError('操作正在进行，请等待结果并刷新列表。', 409);
    this.acting.add(key);
    try { return await action(); } finally { this.acting.delete(key); }
  }

  router(): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.get('/', asyncRoute(async (_req, res) => { res.json(await this.list()); }));
    router.post('/', asyncRoute(async (req, res) => {
      const input = this.settings(record(req.body));
      res.json(await this.act('create', async () => {
        const result = record(await this.request('create', input));
        if (!result.item || typeof result.item !== 'object' || !('id' in result.item)) {
          throw new Error('Desktop 未确认创建成功，请先刷新原生任务列表。');
        }
        return result;
      }));
    }));
    router.patch('/:id', asyncRoute(async (req, res) => {
      const input = record(req.body);
      res.json(await this.act(req.params.id as string, async () => {
        const current = await this.current(req.params.id as string, input.updatedAt);
        const result = record(await this.request('update', this.settings(input, current)));
        if (!result.item || typeof result.item !== 'object' || !('id' in result.item)) {
          throw new Error('Desktop 未确认保存成功，请先刷新原生任务列表。');
        }
        return result;
      }));
    }));
    router.delete('/:id', asyncRoute(async (req, res) => {
      const id = req.params.id as string;
      res.json(await this.act(id, async () => {
        await this.current(id, record(req.body).updatedAt);
        const result = record(await this.request('delete', { id }));
        if (result.success !== true) throw new Error('Desktop 未确认删除成功，请刷新检查任务。');
        return result;
      }));
    }));
    router.post('/:id/run', asyncRoute(async (req, res) => {
      const id = req.params.id as string;
      res.json(await this.act(id, async () => {
        const current = await this.current(id, record(req.body).updatedAt);
        if (current.kind === 'heartbeat') {
          throw new InputError('此任务继续现有聊天，请在 Codex Desktop 中确认聊天权限后运行。', 409);
        }
        const result = record(await this.request('runNow', { id, collaborationMode: null, permissions: null }));
        if (result.success !== true) throw new Error('Desktop 未确认启动成功，请检查原生运行记录。');
        return result;
      }));
    }));
    router.use((error: unknown, _req: import('express').Request, res: import('express').Response,
      _next: import('express').NextFunction) => {
      res.status(error instanceof InputError ? error.status : 502)
        .json({ error: error instanceof Error ? error.message : 'Desktop 自动任务请求失败。' });
    });
    return router;
  }
}
