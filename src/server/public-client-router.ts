import path from 'node:path';
import express from 'express';

export function publicClientRouter(directory: string) {
  const router = express.Router();
  router.use(express.static(directory, {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));
  router.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/ws' || req.path === '/health') return next();
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).sendFile(path.join(directory, '404.html'));
  });
  return router;
}
