import type { RequestHandler } from 'express';

const publicReads = new Set(['/auth/status', '/bootstrap']);
const publicWrites = new Set(['/auth/setup', '/auth/login', '/auth/logout']);

/** All new API routes are private unless explicitly admitted here. */
export function apiBoundary(authenticate: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' && publicReads.has(req.path) ||
        req.method === 'POST' && publicWrites.has(req.path) ||
        req.method === 'GET' && /^\/file-preview\/render\/[^/]+\/.+/.test(req.path)) {
      next(); return;
    }
    authenticate(req, res, next);
  };
}
