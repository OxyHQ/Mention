/**
 * Move's content import boundary. Shared Oxy middleware must verify an active
 * own workload and the original requester session/task for the effective account.
 * The Move-only domain gate remains: an attributed header or external key, even
 * for Move's app registration, is not authority to import a person's history.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { z } from 'zod';
import { PostVisibility } from '@mention/shared-types';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  mentionImportBatchSchema as batchSchema,
  mentionImportLookupSchema as lookupSchema,
  mentionImportIdSchema,
} from '@oxy.so/mention-contracts';
import { config } from '../config';
import { postImportService } from '../services/PostImportService';
import { sanitizeArticle } from '../controllers/posts/composeInput';
import { logger } from '../utils/logger';

const router = Router();

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
  if (
    !moveAppId ||
    !serviceApp ||
    serviceApp.appId !== moveAppId ||
    serviceApp.authority !== 'first_party'
  ) {
    res.status(403).json({
      error: 'IMPORT_CALLER_NOT_ALLOWED',
      message: 'Content import is only available to the Oxy Move service',
    });
    return;
  }
  if (
    !actingUserId ||
    authed.user?.id !== actingUserId ||
    authed.serviceActingAs?.authority !== 'first_party'
  ) {
    res.status(403).json({
      error: 'IMPORT_USER_REQUIRED',
      message: 'The original requester must authorize this account import',
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
    return res
      .status(400)
      .json({ error: 'INVALID_IMPORT_BATCH', message: firstIssue(parsed.error) });
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
        visibility:
          item.visibility === 'public' ? PostVisibility.PUBLIC : PostVisibility.FOLLOWERS_ONLY,
        article: sanitizeArticle(item.article),
      })),
    });
    return res.status(200).json({ results });
  } catch (error) {
    logger.error('[Imports] batch failed', error);
    return res
      .status(500)
      .json({ error: 'IMPORT_FAILED', message: 'The batch could not be imported' });
  }
});

/** `DELETE /imports/v1/batches/:batchId` — undo one batch of the acting user. */
router.delete('/v1/batches/:batchId', async (req: Request, res: Response) => {
  const parsed = mentionImportIdSchema.safeParse(req.params.batchId);
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
    return res
      .status(500)
      .json({ error: 'IMPORT_UNDO_FAILED', message: 'The batch could not be undone' });
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
    return res
      .status(400)
      .json({ error: 'INVALID_IMPORT_LOOKUP', message: firstIssue(parsed.error) });
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
    return res
      .status(500)
      .json({ error: 'IMPORT_LOOKUP_FAILED', message: 'The lookup could not be completed' });
  }
});

export default router;
