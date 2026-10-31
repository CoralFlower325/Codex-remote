import type { NextFunction, Request, Response } from 'express';

export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

