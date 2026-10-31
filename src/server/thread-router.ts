import { Router, type RequestHandler } from 'express';
import type { CodexBridge } from './codex-bridge.js';
import type { WorkspaceSnapshots } from './workspace-snapshots.js';
import type { PushNotifications } from './push-notifications.js';
import type { LocalImages } from './local-images.js';
import { permissionProfileId, type PermissionProfile, type PermissionSettings } from '../shared/permissions.js';
import { isTaskThread } from '../shared/thread-source.js';
import { readConversationHistoryPage, readThreadHistoryAround, readThreadHistoryPage, readThreadOutline } from './thread-history.js';
import { readThreadTimings } from './thread-open.js';
import { readThreadSummaryPage } from './thread-summary.js';
import { withReadDeadline } from './bootstrap.js';
import { asyncRoute } from './http-route.js';

interface ThreadServices {
  requireAuth: RequestHandler;
  codexBridge: Pick<CodexBridge, 'request'>;
  workspaceSnapshots: Pick<WorkspaceSnapshots, 'open' | 'readTimings'>;
  pushNotifications: Pick<PushNotifications, 'watch'>;
  localImages: Pick<LocalImages, 'remember'>;
  recordQuestions(threadId: string, items: unknown[]): void;
  reportImageFailure(): void;
  config: { codexWorkdir: string };
}

export function threadRouter({ requireAuth, codexBridge, workspaceSnapshots,
  pushNotifications, localImages, recordQuestions, reportImageFailure, config }: ThreadServices) {
  const app = Router();
  app.get(
    '/api/thread/open',
    requireAuth,
    asyncRoute(async (req, res) => {
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
      if (!threadId) {
        res.status(400).json({ error: 'threadId is required.' });
        return;
      }
      const mode = req.query.mode === 'new' || req.query.mode === 'read' ? req.query.mode : 'resume';
      res.setHeader('Cache-Control', 'no-store');
      const result = await workspaceSnapshots.open(threadId, mode, req.query.fresh === '1');
      const thread = (result.result as { thread?: { id: string; source?: unknown; ephemeral?: boolean } }).thread;
      if (thread && isTaskThread(thread)) pushNotifications.watch(thread.id);
      recordQuestions(threadId, result.items.map(entry => entry.item));
      for (const entry of result.items) void localImages.remember(entry.item).catch(reportImageFailure);
      if (!res.destroyed) res.json(result);
    })
  );

  app.get('/api/thread/summary', requireAuth, asyncRoute(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const attachmentCursor = typeof req.query.attachmentsCursor === 'string' ? req.query.attachmentsCursor : null;
    res.json(await withReadDeadline(readThreadSummaryPage(
      (method, params) => codexBridge.request(method, params), threadId, cursor, attachmentCursor,
      req.query.attachmentsOnly === '1'
    )));
  }));

  app.get('/api/thread/timings', requireAuth, asyncRoute(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    res.json(await (cursor ? withReadDeadline(readThreadTimings(
      (method, params) => codexBridge.request(method, params), threadId, cursor
    )) : workspaceSnapshots.readTimings(threadId, req.query.fresh === '1')));
  }));

  app.get(
    '/api/thread/history',
    requireAuth,
    asyncRoute(async (req, res) => {
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
      if (!threadId) {
        res.status(400).json({ error: 'threadId is required.' });
        return;
      }
      const direction = typeof req.query.after === 'string' ? 'asc' : 'desc';
      const cursor = typeof req.query.after === 'string' ? req.query.after : typeof req.query.before === 'string' ? req.query.before : null;
      const limitValue =
        typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
      const limit = Number.isFinite(limitValue) ? Math.min(400, Math.max(1, limitValue)) : 200;
      res.setHeader('Cache-Control', 'no-store');
      const request = (method: import('../shared/protocol.js').ClientRpcMethod, params: unknown) => codexBridge.request(method, params);
      const result = await withReadDeadline(cursor && direction === 'desc' && req.query.conversation === '1'
        ? readConversationHistoryPage(request, threadId, cursor, Math.min(limit, 100))
        : readThreadHistoryPage(request, threadId, cursor, limit, direction));
      recordQuestions(threadId, result.items.map(entry => entry.item));
      for (const entry of result.items) void localImages.remember(entry.item).catch(reportImageFailure);
      res.json(result);
    })
  );

  app.get(
    '/api/thread/outline',
    requireAuth,
    asyncRoute(async (req, res) => {
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
      if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readThreadOutline((method, params) => codexBridge.request(method, params), threadId, cursor));
    })
  );

  app.get(
    '/api/thread/around',
    requireAuth,
    asyncRoute(async (req, res) => {
      const { threadId, turnId, itemId } = req.query;
      if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId ||
          typeof itemId !== 'string' || !itemId) {
        res.status(400).json({ error: 'threadId, turnId and itemId are required.' }); return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readThreadHistoryAround((method, params) => codexBridge.request(method, params), threadId, turnId, itemId));
    })
  );

  app.get(
    '/api/permissions',
    requireAuth,
    asyncRoute(async (req, res) => {
      const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : config.codexWorkdir;
      const profiles: PermissionProfile[] = [];
      let cursor: string | null = null;
      do {
        const result = await codexBridge.request('permissionProfile/list', { cwd, limit: 100, ...(cursor ? { cursor } : {}) }) as {
          data: PermissionProfile[]; nextCursor?: string | null;
        };
        profiles.push(...result.data.filter((profile) => profile.allowed));
        cursor = result.nextCursor ?? null;
      } while (cursor);
      const result = await codexBridge.request('config/read', { cwd, includeLayers: false }) as { config: PermissionSettings };
      const defaultProfile = permissionProfileId(result.config);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: profiles, defaultProfile: profiles.some((profile) => profile.id === defaultProfile) ? defaultProfile : null });
    })
  );

  return app;
}
