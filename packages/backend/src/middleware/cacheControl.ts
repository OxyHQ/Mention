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

export const cachePublicShort = cacheControl('public, max-age=60, s-maxage=300');
export const cachePublicMedium = cacheControl('public, max-age=120, s-maxage=600');
export const cachePublicProfile = cacheControl('public, max-age=30, s-maxage=120');
export const cachePrivateNoStore = cacheControl('private, no-cache, no-store');
