import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isLiveEntityId } from '@oxyhq/db';
import { sendError, ErrorCodes } from '../utils/apiResponse';

/**
 * Express middleware factory for request body validation using Zod schemas.
 * Validated data is available as req.body (replaced with parsed result).
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      sendError(res, ErrorCodes.VALIDATION_ERROR, message, 400);
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Express middleware rejecting a route param that could not name any row.
 *
 * This is one of the few id-shape checks the Postgres port KEEPS, because the
 * 400 is a documented contract a client reads rather than an internal guard: the
 * rest were `CastError` shims whose `false` branch silently meant "allowed" or
 * "not found". It accepts BOTH live id shapes — see `@oxyhq/db` — since a
 * 24-hex-only test would 400 every entity created after the cutover.
 *
 * @param paramName - The name of the param to validate (default: 'id')
 */
export function validateObjectId(paramName: string = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = req.params[paramName];
    if (!id) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `${paramName} parameter is required`, 400);
      return;
    }
    // Handle both string and string[] (Express params can be arrays with duplicate path segments)
    const idString = Array.isArray(id) ? id[0] : id;
    if (!isLiveEntityId(idString)) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `Invalid ${paramName} format`, 400);
      return;
    }
    next();
  };
}

/**
 * Common validation schemas for reuse across routes.
 *
 * These are the schemas `validateBody` is actually mounted with. The file also
 * carried a `createPost` / `createReply` / `likeRequest` / `paginationQuery` set
 * describing the composer's payload, referenced by nothing but its own test —
 * schemas gating zero traffic while `POST /posts` and `POST /posts/thread`
 * validated their bodies by hand and got four fields wrong. The real path is
 * validated in `controllers/posts/composeInput.ts`, at the point the values are
 * used; the descriptions that never ran are gone rather than left to look like
 * a contract.
 */
export const schemas = {
  /** Feed review creation/update request body */
  createFeedReview: z.object({
    rating: z.number().int().min(1).max(5),
    reviewText: z.string().max(500).optional(),
  }),

  /** Custom feed members management request body */
  manageFeedMembers: z.object({
    userIds: z.array(z.string().min(1).max(100, 'User ID too long')).min(1, 'At least one user ID is required').max(100, 'Maximum 100 user IDs per request'),
  }),
};
