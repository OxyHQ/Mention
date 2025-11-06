import { AuthRequest } from '../middleware/auth';

/**
 * Extracts authenticated user ID from request
 * Should only be called after requireAuth middleware
 */
export function getAuthenticatedUserId(req: AuthRequest): string {
  if (!req.user?.id) {
    throw new Error('User not authenticated');
  }
  return req.user.id;
}

