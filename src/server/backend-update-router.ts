import { Router, type RequestHandler } from 'express';
import type { BackendUpdateRequest, BackendUpdateStatus, BackendUpdateCheck, BackendUpdateOperation } from '../shared/backend-update.js';
import { asyncRoute } from './http-route.js';

interface Updater {
  status(id?: string): Promise<BackendUpdateStatus>;
  check(): Promise<BackendUpdateCheck>;
  start(request: BackendUpdateRequest): Promise<BackendUpdateOperation>;
}
export function backendUpdateRouter(requireAuth: RequestHandler, trusted: RequestHandler, updater: () => Promise<Updater>) {
  const router = Router();
  router.use(requireAuth);
  router.get('/', asyncRoute(async (req, res) => {
    const id = req.query.id;
    if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) {
      res.status(400).json({ error: '更新任务无效。' }); return;
    }
    res.json(await (await updater()).status(id));
  }));
  router.post('/check', trusted, asyncRoute(async (_req, res) => {
    res.json(await (await updater()).check());
  }));
  router.post('/install', trusted, asyncRoute(async (req, res) => {
    const { id, version, token, recover } = req.body ?? {};
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) ||
      typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token) ||
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      recover !== undefined && typeof recover !== 'boolean') {
      res.status(400).json({ error: '更新请求无效，请重新检查版本。' }); return;
    }
    res.status(202).json(await (await updater()).start({ id, version, token,
      ...(recover === undefined ? {} : { recover }) }));
  }));
  return router;
}
