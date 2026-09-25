/**
 * The content-import API — the server-to-server door Oxy Move writes through.
 *
 * Contract (request/response shapes, statuses, guarantees): `docs/import.mdx`.
 * Domain behaviour: `services/PostImportService.ts`. This file is the gate and
 * the validation.
 *
 * ## Who may call: Oxy Move, and only Oxy Move
 *
 * The caller must present an Oxy SERVICE TOKEN whose application id is exactly
 * `MOVE_APPLICATION_ID`, plus `X-Oxy-User-Id` naming the user the import is for.
 * `oxy.auth()` (mounted in front of this router as `requireAuth`) verifies the
 * token and puts the application on `req.serviceApp`, and — for one of Oxy's own
 * INTERNAL-tier applications — accepts the delegated user without a grant.
 *
 * That tier rule is exactly why this gate exists: every internal application may
 * act as every user, so "a service token acting for this user" is not an
 * authorization to write years of posts into their profile. This route admits
 * one application by id, and refuses everything else with 403:
 *
 * - a user SESSION (no `req.serviceApp`) — a person imports through Move, not
 *   by calling this directly;
 * - an MCP token or a capability ticket, which never populate `req.serviceApp`;
 * - any OTHER service application, internal or not;
 * - Move itself without `X-Oxy-User-Id` (acting as itself, for nobody).
 *
 * Unset `MOVE_APPLICATION_ID` admits nobody.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { IMPORT_PLATFORMS, PostVisibility } from '@mention/shared-types';
import { config } from '../config';
import {
  MAX_IMPORT_BATCH_ITEMS,
  MAX_IMPORT_LINKS_PER_ITEM,
  MAX_IMPORT_MEDIA_PER_ITEM,
  postImportService,
} from '../services/PostImportService';
import { sanitizeArticle } from '../controllers/posts/composeInput';
import { logger } from '../utils/logger';

const router = Router();

/** An opaque id from another system: bounded, no whitespace at the ends. */
const opaqueId = (label: string) =>
  z
    .string(`${label} must be a string`)
    .trim()
    .min(1, `${label} must not be empty`)
    .max(512, `${label} must be at most 512 characters`);

const httpUrl = (label: string) =>
  z
    .string(`${label} must be a string`)
    .trim()
    .max(2048, `${label} must be at most 2048 characters`)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    }, `${label} must be an http(s) URL`);

const platformSchema = z.enum(IMPORT_PLATFORMS, `platform must be one of: ${IMPORT_PLATFORMS.join(', ')}`);

const itemSchema = z.object({
  sourceId: opaqueId('sourceId'),
  sourceUrl: httpUrl('sourceUrl'),
  // ISO 8601 with an offset. Stored at millisecond precision — a JS Date cannot
  // hold more, and the feed cursor is millisecond-precise (0002 migration).
  createdAt: z.iso.datetime({ offset: true, message: 'createdAt must be an ISO 8601 date-time' }),
  text: z.string('text must be a string').max(config.posts.maxTextLength).default(''),
  contentWarning: z.string().trim().max(500).optional(),
  language: z.string().trim().min(2).max(35).optional(),
  visibility: z.enum([PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
  replyToSourceId: opaqueId('replyToSourceId').optional(),
  quoteSourceId: opaqueId('quoteSourceId').optional(),
  media: z
    .array(z.object({
      assetId: opaqueId('media.assetId'),
      alt: z.string().max(config.posts.maxAltTextLength * 2).optional(),
    }))
    .max(MAX_IMPORT_MEDIA_PER_ITEM)
    .default([]),
  article: z
    .object({ title: z.string().optional(), body: z.string().optional() })
    .optional(),
  links: z.array(httpUrl('links[]')).max(MAX_IMPORT_LINKS_PER_ITEM).optional(),
});

const batchSchema = z.object({
  platform: platformSchema,
  batchId: opaqueId('batchId'),
  items: z
    .array(itemSchema)
    .min(1, 'items must not be empty')
    .max(MAX_IMPORT_BATCH_ITEMS, `items must hold at most ${MAX_IMPORT_BATCH_ITEMS} entries`),
});

/**
 * Repeated query values (`?sourceIds=a&sourceIds=b`); empty entries dropped.
 * Never split on commas: a source id or an AS2 id is often a URL, and a URL may
 * carry one.
 */
function queryList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const MAX_LOOKUP_IDS = 200;

const lookupSchema = z.object({
  platform: platformSchema,
  sourceIds: z.array(opaqueId('sourceIds[]')).max(MAX_LOOKUP_IDS),
  federatedIds: z.array(opaqueId('federatedIds[]')).max(MAX_LOOKUP_IDS),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

/**
 * Admit Oxy Move acting for a user, and nobody else. See the module docblock.
 * Sets `res.locals.importUserId` for the handlers.
 */
function requireMoveServiceCaller(req: Request, res: Response, next: NextFunction): void {
  const authed = req as OxyAuthRequest;
  const moveAppId = config.imports.moveApplicationId;
  const serviceApp = authed.serviceApp;
  const actingUserId = authed.serviceActingAs?.userId;
  if (!moveAppId || !serviceApp || serviceApp.appId !== moveAppId) {
    res.status(403).json({
      error: 'IMPORT_CALLER_NOT_ALLOWED',
      message: 'Content import is only available to the Oxy Move service',
    });
    return;
  }
  if (!actingUserId || authed.user?.id !== actingUserId) {
    res.status(403).json({
      error: 'IMPORT_USER_REQUIRED',
      message: 'X-Oxy-User-Id must name the user the import is for',
    });
    return;
  }
  res.locals.importUserId = actingUserId;
  next();
}

router.use(requireMoveServiceCaller);

/** `POST /imports/v1/posts:batch` — import up to 50 items, in order. */
router.post('/v1/posts\\:batch', async (req: Request, res: Response) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_IMPORT_BATCH', message: firstIssue(parsed.error) });
  }
  const { platform, batchId, items } = parsed.data;
  try {
    const results = await postImportService.ingestBatch({
      oxyUserId: res.locals.importUserId as string,
      platform,
      batchId,
      items: items.map((item) => ({
        ...item,
        createdAt: new Date(item.createdAt),
        article: sanitizeArticle(item.article),
      })),
    });
    return res.status(200).json({ results });
  } catch (error) {
    logger.error('[Imports] batch failed', error);
    return res.status(500).json({ error: 'IMPORT_FAILED', message: 'The batch could not be imported' });
  }
});

/** `DELETE /imports/v1/batches/:batchId` — undo one batch of the acting user. */
router.delete('/v1/batches/:batchId', async (req: Request, res: Response) => {
  const parsed = opaqueId('batchId').safeParse(req.params.batchId);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_BATCH_ID', message: firstIssue(parsed.error) });
  }
  try {
    const { deleted, failed } = await postImportService.undoBatch({
      oxyUserId: res.locals.importUserId as string,
      batchId: parsed.data,
    });
    return res.status(200).json({ deleted, failed });
  } catch (error) {
    logger.error('[Imports] undo failed', error);
    return res.status(500).json({ error: 'IMPORT_UNDO_FAILED', message: 'The batch could not be undone' });
  }
});

/** `GET /imports/v1/lookup?platform=&sourceIds=&federatedIds=` — what Mention already holds. */
router.get('/v1/lookup', async (req: Request, res: Response) => {
  const parsed = lookupSchema.safeParse({
    platform: req.query.platform,
    sourceIds: queryList(req.query.sourceIds),
    federatedIds: queryList(req.query.federatedIds),
  });
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_IMPORT_LOOKUP', message: firstIssue(parsed.error) });
  }
  try {
    const result = await postImportService.lookup({
      oxyUserId: res.locals.importUserId as string,
      platform: parsed.data.platform,
      sourceIds: parsed.data.sourceIds,
      federatedIds: parsed.data.federatedIds,
    });
    return res.status(200).json(result);
  } catch (error) {
    logger.error('[Imports] lookup failed', error);
    return res.status(500).json({ error: 'IMPORT_LOOKUP_FAILED', message: 'The lookup could not be completed' });
  }
});

export default router;
