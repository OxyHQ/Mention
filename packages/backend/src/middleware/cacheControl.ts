import { Request, Response, NextFunction } from 'express';

export function cacheControl(directive: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', directive);
    if (directive.startsWith('public')) {
      res.set('Vary', 'Authorization');
    }
    next();
  };
}

export const cachePublicMedium = cacheControl('public, max-age=120, s-maxage=600');
