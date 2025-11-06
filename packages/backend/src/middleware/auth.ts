import { Request, Response, NextFunction } from 'express';

/**
 * Extended Request interface with authenticated user
 * User is optional until requireAuth middleware validates it
 */
export interface AuthRequest extends Request {
  user?: {
    id: string;
  };
}

/**
 * Middleware to require authentication
 * Returns 401 if user is not authenticated
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.id) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }
  next();
}

