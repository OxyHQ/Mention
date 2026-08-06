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

/** A `MediaItem` as a client submits it: the id and kind, plus optional metadata. */
const mediaItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['image', 'video', 'gif']),
  alt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  sizeBytes: z.number().optional(),
  mime: z.string().optional(),
});

/** A `GeoJSONPoint` — `[longitude, latitude]`, optionally with a readable address. */
const locationSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
  address: z.string().optional(),
});

/** A `PostSourceLink` cited within the post body. */
const sourceLinkSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
});

/** A `PostArticleContent` — long-form body attached to the post. */
const articleSchema = z.object({
  articleId: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  excerpt: z.string().optional(),
});

/** A `PostEventContent` — name and ISO date are the only required parts. */
const eventSchema = z.object({
  eventId: z.string().optional(),
  name: z.string().min(1),
  date: z.string().min(1),
  location: z.string().optional(),
  description: z.string().optional(),
});

/** A `PostAttachmentDescriptor` — the render order of the post's attachments. */
const attachmentSchema = z.object({
  type: z.enum(['media', 'poll', 'article', 'location', 'sources', 'event', 'room', 'podcast']),
  id: z.string().optional(),
  mediaType: z.enum(['image', 'video', 'gif']).optional(),
});

/** The `PostContentInput` a client submits, for a top-level post or a reply. */
const postContentSchema = z.object({
  text: z.string().max(5000).default(''),
  media: z.array(mediaItemSchema).max(10).optional(),
  poll: z.object({
    question: z.string().min(1).max(280),
    options: z.array(z.string().min(1).max(100)).min(2).max(4),
    endTime: z.string().optional(),
    isMultipleChoice: z.boolean().optional(),
    isAnonymous: z.boolean().optional(),
  }).optional(),
  location: locationSchema.optional(),
  sources: z.array(sourceLinkSchema).max(5).optional(),
  article: articleSchema.optional(),
  event: eventSchema.optional(),
  attachments: z.array(attachmentSchema).optional(),
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
