import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { sendError, ErrorCodes } from '../utils/apiResponse';
import { FEED_CATEGORIES } from '../models/CustomFeed';

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

// --- Reusable sub-schemas ---

/** Media item: an uploaded file reference with id and type */
const mediaItemSchema = z.object({
  id: z.string().min(1).max(500),
  type: z.enum(['image', 'video', 'gif']),
});

/** GeoJSON Point location */
const locationSchema = z.object({
  type: z.literal('Point').optional(),
  coordinates: z.tuple([
    z.number().min(-180).max(180), // longitude
    z.number().min(-90).max(90),   // latitude
  ]).optional(),
  address: z.string().max(500).optional(),
}).optional();

/** External source citation */
const sourceSchema = z.object({
  url: z.string().url().max(2048),
  title: z.string().max(200).optional(),
});

/** Article attachment */
const articleSchema = z.object({
  articleId: z.string().optional(),
  title: z.string().max(280).optional(),
  excerpt: z.string().max(280).optional(),
}).optional();

/** Event attachment */
const eventSchema = z.object({
  name: z.string().max(200),
  startDate: z.string(),
  endDate: z.string().optional(),
  location: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
}).optional();

/** Post attachment descriptor */
const attachmentSchema = z.object({
  type: z.enum(['media', 'poll', 'article', 'event', 'location', 'sources', 'space']),
  id: z.string().optional(),
  mediaType: z.enum(['image', 'video', 'gif']).optional(),
});

/** Post content schema shared between create and reply */
const postContentSchema = z.object({
  text: z.string().max(25000).default(''),
  media: z.array(mediaItemSchema).max(10).optional(),
  poll: z.object({
    question: z.string().min(1).max(280),
    options: z.array(z.string().min(1).max(100)).min(2).max(4),
    endTime: z.string().optional(),
    isMultipleChoice: z.boolean().optional(),
    isAnonymous: z.boolean().optional(),
  }).optional(),
  location: locationSchema,
  sources: z.array(sourceSchema).max(5).optional(),
  article: articleSchema,
  event: eventSchema,
  attachments: z.array(attachmentSchema).max(20).optional(),
});

/**
 * Common validation schemas for reuse across routes.
 */
export const schemas = {
  /** Post creation request body */
  createPost: z.object({
    content: postContentSchema.optional().default({ text: '' }),
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
    content: postContentSchema.optional().default({ text: '' }),
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
    category: z.enum(FEED_CATEGORIES).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20, 'Maximum 20 tags allowed').optional().default([]),
    coverImage: z.string().url('Cover image must be a valid URL').optional(),
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
    category: z.enum(FEED_CATEGORIES).optional().nullable(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    coverImage: z.string().url('Cover image must be a valid URL').optional().nullable(),
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
