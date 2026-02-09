import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

/**
 * Parse ADMIN_USER_IDS environment variable into a Set for O(1) lookups.
 * The env var is a comma-separated list of user IDs.
 */
const ADMIN_USER_IDS: Set<string> = new Set(
  (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

if (ADMIN_USER_IDS.size > 0) {
  logger.info(`Admin middleware initialized with ${ADMIN_USER_IDS.size} admin user(s)`);
} else {
  logger.warn('Admin middleware initialized with NO admin users (ADMIN_USER_IDS is empty or unset)');
}

/**
 * Check whether a given userId is an app admin.
 */
export function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.has(userId);
}

/**
 * Express middleware that requires the authenticated user to be an admin.
 * Must be placed AFTER authentication middleware so that `req.user` is set.
 * Returns 403 Forbidden if the user is not in the admin list.
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }

  if (!isAdmin(userId)) {
    logger.warn(`Non-admin user ${userId} attempted to access admin route: ${req.method} ${req.originalUrl}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
  }

  next();
}
