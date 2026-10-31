import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { asyncRoute } from './http-route.js';

// Public application assets only, bypassing a separately deployed static edge.
export function updateClientRouter(client: string) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });
  router.get('/sw.js', (_req, res) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(client, 'sw-origin.js'));
  });
  router.get(['/', '/index.html'], asyncRoute(async (_req, res) => {
    const html = await fs.readFile(path.join(client, 'index.html'), 'utf8');
    res.type('html').send(html.replace(/((?:src|href)=["'])\/assets\//g, '$1/remote-client/assets/'));
  }));
  router.use(express.static(client, { index: false, dotfiles: 'deny' }));
  return router;
}
