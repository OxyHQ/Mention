import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
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
    req.query = result.data;
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
    replyPermission: z.enum(['anyone', 'followers', 'following', 'mentioned']).optional().default('anyone'),
    reviewReplies: z.boolean().optional().default(false),
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

  /** Custom feed creation request body */
  createCustomFeed: z.object({
    title: z.string().min(1, 'Title is required').max(100, 'Title must be 100 characters or less').transform(s => s.trim()),
    description: z.string().max(500, 'Description must be 500 characters or less').optional().transform(s => s?.trim()),
    isPublic: z.boolean().optional().default(false),
    memberOxyUserIds: z.array(z.string().min(1).max(100)).max(200, 'Maximum 200 members allowed').optional().default([]),
    keywords: z.array(z.string().min(1).max(100)).max(50, 'Maximum 50 keywords allowed').optional().default([]),
    includeReplies: z.boolean().optional().default(true),
    includeReposts: z.boolean().optional().default(true),
    includeMedia: z.boolean().optional().default(true),
    language: z.string().min(2).max(10).regex(/^[a-zA-Z-]+$/, 'Invalid language code').optional(),
  }),

  /** Custom feed update request body */
  updateCustomFeed: z.object({
    title: z.string().min(1).max(100).transform(s => s.trim()).optional(),
    description: z.string().max(500).transform(s => s?.trim()).optional().nullable(),
    isPublic: z.boolean().optional(),
    memberOxyUserIds: z.array(z.string().min(1).max(100)).max(200).optional(),
    keywords: z.array(z.string().min(1).max(100)).max(50).optional(),
    includeReplies: z.boolean().optional(),
    includeReposts: z.boolean().optional(),
    includeMedia: z.boolean().optional(),
    language: z.string().min(2).max(10).regex(/^[a-zA-Z-]+$/).optional().nullable(),
  }),
};
