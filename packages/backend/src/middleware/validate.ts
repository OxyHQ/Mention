import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
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
 * Express middleware factory for query parameter validation using Zod schemas.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      sendError(res, ErrorCodes.VALIDATION_ERROR, message, 400);
      return;
    }
    req.query = result.data as typeof req.query;
    next();
  };
}

/**
 * Express middleware to validate MongoDB ObjectId in route params.
 * Validates req.params[paramName] is a valid ObjectId format.
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
    if (!idString || !mongoose.Types.ObjectId.isValid(idString)) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `Invalid ${paramName} format`, 400);
      return;
    }
    next();
  };
}

/**
 * Common validation schemas for reuse across routes.
 */
export const schemas = {
  /** Post creation request body */
  createPost: z.object({
    content: z.object({
      text: z.string().max(5000).default(''),
      media: z.array(z.any()).max(10).optional(),
      poll: z.object({
        question: z.string().min(1).max(280),
        options: z.array(z.string().min(1).max(100)).min(2).max(4),
        endTime: z.string().optional(),
        isMultipleChoice: z.boolean().optional(),
        isAnonymous: z.boolean().optional(),
      }).optional(),
      location: z.any().optional(),
      sources: z.array(z.any()).max(5).optional(),
      article: z.any().optional(),
      event: z.any().optional(),
      attachments: z.array(z.any()).optional(),
    }).optional().default({ text: '' }),
    hashtags: z.array(z.string()).optional(),
    mentions: z.array(z.string()).optional(),
    visibility: z.enum(['public', 'private', 'followers_only']).optional().default('public'),
    parentPostId: z.string().optional().nullable(),
    threadId: z.string().optional().nullable(),
    replyPermission: z.array(z.enum(['anyone', 'followers', 'following', 'mentioned', 'nobody'])).optional().default(['anyone']),
    reviewReplies: z.boolean().optional().default(false),
    quotesDisabled: z.boolean().optional().default(false),
    status: z.enum(['draft', 'published', 'scheduled']).optional(),
    scheduledFor: z.string().optional(),
  }),

  /** Like/unlike request body */
  likeRequest: z.object({
    postId: z.string().min(1),
    type: z.string().optional().default('post'),
  }),

  /** Reply creation request body */
  createReply: z.object({
    postId: z.string().min(1),
    content: z.any(),
    mentions: z.array(z.string()).optional(),
    hashtags: z.array(z.string()).optional(),
  }),

  /** Pagination query params */
  paginationQuery: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),

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
