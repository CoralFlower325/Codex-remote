import { Router, type RequestHandler } from 'express';
import type { ClientRpcMethod } from '../shared/protocol.js';
import { readCompleteCatalog, type CatalogKind } from '../shared/catalog.js';

type Read = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;
type Clear = (kind?: 'model/list' | 'project/list') => void;

export function metadataRouter(requireAuth: RequestHandler, read: Read, clear?: Clear): Router {
  const router = Router();
  router.get('/', requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const kind = req.query.kind;
    if (kind !== 'projects' && kind !== 'models') {
      res.status(400).json({ error: 'kind must be projects or models.' });
      return;
    }
    try {
      const catalogKind: CatalogKind = kind;
      if (req.query.fresh === '1') {
        clear?.(catalogKind === 'models' ? 'model/list' : 'project/list');
      }
      res.json(await readCompleteCatalog(read, catalogKind));
    } catch (error) { next(error); }
  });
  return router;
}
