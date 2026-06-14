/**
 * Muted Words & Hashtags API
 *
 * CRUD for a user's muted words / muted hashtags. Persisted via the MuteWord
 * MTN-protocol record and consumed by the `filterMuteWords` feed tuner so that
 * matching posts are dropped from every feed for the requesting user.
 *
 * Mounted under the authenticated API router (`oxy.auth()` guarantees
 * `req.user.id`), so every route is scoped to the current Oxy user.
 *
 * Public path prefix: `/mute-words`
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { MuteWord } from '../models/MuteWord';
import { AuthRequest, requireAuth } from '../middleware/auth';
import { validateBody, validateObjectId } from '../middleware/validate';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { getAuthenticatedUserId } from '../utils/auth';
import { normalizeHashtag } from '../utils/textProcessing';
import { logger } from '../utils/logger';

const router = Router();

/** Maximum muted entries a single user may have. */
const MAX_MUTE_WORDS_PER_USER = 200;

/** Maximum length of a muted word/phrase (mirrors the model `maxlength`). */
const MAX_MUTE_WORD_LENGTH = 100;

type MuteTarget = 'content' | 'tag';
const DEFAULT_TARGETS: MuteTarget[] = ['content', 'tag'];

// Apply auth to all routes (defensive — the parent router already enforces it).
router.use(requireAuth);

const muteTargetSchema = z.enum(['content', 'tag']);

const createMuteWordSchema = z.object({
  value: z
    .string()
    .min(1, 'value is required')
    .max(MAX_MUTE_WORD_LENGTH, `value must be ${MAX_MUTE_WORD_LENGTH} characters or less`)
    .transform((s) => s.trim()),
  targets: z.array(muteTargetSchema).min(1, 'targets must be a non-empty array').optional(),
  actorTarget: z.enum(['all', 'exclude-following']).optional(),
});

const updateMuteWordSchema = z.object({
  targets: z.array(muteTargetSchema).min(1, 'targets must be a non-empty array').optional(),
  actorTarget: z.enum(['all', 'exclude-following']).optional(),
});

interface SerializedMuteWord {
  id: string;
  value: string;
  targets: MuteTarget[];
  actorTarget: 'all' | 'exclude-following';
  createdAt: Date;
}

/** Shape of a `MuteWord` document returned by a `.lean()` query. */
interface MuteWordLean {
  _id: unknown;
  value: string;
  targets: MuteTarget[];
  actorTarget: 'all' | 'exclude-following';
  createdAt: Date;
}

/**
 * Normalize a raw mute value and resolve its target list.
 *
 * A leading `#` marks a hashtag mute: the `#` is stripped and `'tag'` is forced
 * into the target list. Hashtag values are normalized via `normalizeHashtag`
 * (strip `#`, trim, lowercase) so they match the lowercase, `#`-less tags stored
 * on `post.metadata.hashtags` and the lowercased Set built by `filterMuteWords`.
 *
 * Content-only values are trimmed but case-preserved — `filterMuteWords` uses a
 * case-insensitive (`/i`) word-boundary regex for content matching.
 */
function normalizeMuteValue(
  rawValue: string,
  requestedTargets: MuteTarget[] | undefined,
): { value: string; targets: MuteTarget[] } | null {
  const isHashtag = rawValue.startsWith('#');
  const targetSet = new Set<MuteTarget>(requestedTargets ?? DEFAULT_TARGETS);

  if (isHashtag) {
    targetSet.add('tag');
    const normalized = normalizeHashtag(rawValue);
    if (!normalized) return null;
    return { value: normalized, targets: Array.from(targetSet) };
  }

  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  // Tag-target values must match lowercase post hashtags, so store them lowercase.
  const value = targetSet.has('content') ? trimmed : trimmed.toLowerCase();
  return { value, targets: Array.from(targetSet) };
}

function serialize(doc: MuteWordLean): SerializedMuteWord {
  return {
    id: String(doc._id),
    value: doc.value,
    targets: doc.targets,
    actorTarget: doc.actorTarget,
    createdAt: doc.createdAt,
  };
}

/**
 * GET /mute-words
 * List the current user's muted words/hashtags (newest first).
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const docs = await MuteWord.find({ userId }).sort({ createdAt: -1 }).lean<MuteWordLean[]>();
    const items = docs.map(serialize);
    return sendSuccessResponse(res, 200, items);
  } catch (err) {
    logger.error('[MuteWords] Error listing muted words:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list muted words');
  }
});

/**
 * POST /mute-words
 * Body: { value: string, targets?: ('content'|'tag')[], actorTarget?: 'all'|'exclude-following' }
 * Create a muted entry. Returns the created entry (201). If the same value
 * already exists for this user, returns the existing entry (200) — idempotent.
 */
router.post('/', validateBody(createMuteWordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { value: rawValue, targets, actorTarget } = req.body as z.infer<typeof createMuteWordSchema>;

    const normalized = normalizeMuteValue(rawValue, targets);
    if (!normalized) {
      return sendErrorResponse(res, 400, 'Bad Request', 'value must not be empty after normalization');
    }
    if (normalized.value.length > MAX_MUTE_WORD_LENGTH) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `value must be ${MAX_MUTE_WORD_LENGTH} characters or less`,
      );
    }

    // Idempotency short-circuit: if it already exists, return it unchanged.
    const existing = await MuteWord.findOne({ userId, value: normalized.value }).lean<MuteWordLean | null>();
    if (existing) {
      return sendSuccessResponse(res, 200, serialize(existing), 'Muted word already exists');
    }

    // Enforce per-user cap.
    const count = await MuteWord.countDocuments({ userId });
    if (count >= MAX_MUTE_WORDS_PER_USER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can have at most ${MAX_MUTE_WORDS_PER_USER} muted words`,
      );
    }

    try {
      const created = await MuteWord.create({
        userId,
        value: normalized.value,
        targets: normalized.targets,
        actorTarget: actorTarget ?? 'all',
      });
      return sendSuccessResponse(res, 201, serialize(created), 'Muted word created');
    } catch (createErr) {
      // Unique {userId,value} index — concurrent insert raced us. Return the winner.
      if ((createErr as { code?: number }).code === 11000) {
        const winner = await MuteWord.findOne({ userId, value: normalized.value }).lean<MuteWordLean | null>();
        if (winner) {
          return sendSuccessResponse(res, 200, serialize(winner), 'Muted word already exists');
        }
      }
      throw createErr;
    }
  } catch (err) {
    logger.error('[MuteWords] Error creating muted word:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to create muted word');
  }
});

/**
 * PATCH /mute-words/:id
 * Body: { targets?: ('content'|'tag')[], actorTarget?: 'all'|'exclude-following' }
 * Update targets / actorTarget of an existing entry. Scoped to the current user.
 */
router.patch(
  '/:id',
  validateObjectId('id'),
  validateBody(updateMuteWordSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { targets, actorTarget } = req.body as z.infer<typeof updateMuteWordSchema>;

      const update: { targets?: MuteTarget[]; actorTarget?: 'all' | 'exclude-following' } = {};
      if (targets) update.targets = targets;
      if (actorTarget) update.actorTarget = actorTarget;

      if (Object.keys(update).length === 0) {
        return sendErrorResponse(res, 400, 'Bad Request', 'Nothing to update');
      }

      const updated = await MuteWord.findOneAndUpdate(
        { _id: req.params.id, userId },
        { $set: update },
        { new: true },
      ).lean<MuteWordLean | null>();

      if (!updated) {
        return sendErrorResponse(res, 404, 'Not Found', 'Muted word not found');
      }
      return sendSuccessResponse(res, 200, serialize(updated), 'Muted word updated');
    } catch (err) {
      logger.error('[MuteWords] Error updating muted word:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update muted word');
    }
  },
);

/**
 * DELETE /mute-words/:id
 * Delete a muted entry by id, scoped to the current user. 404 if not found.
 */
router.delete('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const result = await MuteWord.findOneAndDelete({ _id: req.params.id, userId }).lean();
    if (!result) {
      return sendErrorResponse(res, 404, 'Not Found', 'Muted word not found');
    }
    return sendSuccessResponse(res, 200, { success: true }, 'Muted word deleted');
  } catch (err) {
    logger.error('[MuteWords] Error deleting muted word:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to delete muted word');
  }
});

export default router;
