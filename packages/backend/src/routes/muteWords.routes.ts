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
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/postgres';
import { muteWords, MUTE_WORD_TARGETS } from '../db/schema/engagement';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { validateBody, validateObjectId } from '../middleware/validate';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { normalizeHashtag } from '../utils/textProcessing';
import { logger } from '../utils/logger';

const router = Router();

/** Maximum muted entries a single user may have. */
const MAX_MUTE_WORDS_PER_USER = 200;

/**
 * Maximum length of a muted word/phrase.
 *
 * `mute_words_value_length_check` enforces the same ceiling in the database, so
 * this is the documented 400 rather than the only line of defence. The two
 * measure slightly differently — Postgres `length()` counts CHARACTERS while
 * JavaScript `.length` counts UTF-16 code units — which makes the check here the
 * stricter of the pair, so the constraint can never be the thing a client meets.
 */
const MAX_MUTE_WORD_LENGTH = 100;

type MuteTarget = (typeof MUTE_WORD_TARGETS)[number];
const DEFAULT_TARGETS: MuteTarget[] = ['content', 'tag'];

/**
 * Narrow one stored `targets` element.
 *
 * `targets` is a `text[]`, so drizzle types it `string[]`: the element CHECK
 * (`mute_words_targets_check`) bounds the VALUES but cannot narrow the TYPE.
 * This is how the response is typed without a cast — not a second line of
 * defence, and it can never drop an element while the constraint holds.
 */
function isMuteTarget(value: string): value is MuteTarget {
  return (MUTE_WORD_TARGETS as readonly string[]).includes(value);
}

/**
 * The `:id` path param as a string.
 *
 * `validateObjectId` already rejected a missing or malformed id with the
 * documented 400, so this only has to satisfy Express 5's `string | string[]`
 * typing. A non-string becomes `''`, which names no row and answers 404 — never
 * coerced into a plausible-looking id the way `String([x])` would.
 */
function pathId(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

// Apply auth to all routes (defensive — the parent router already enforces it).
router.use(requireAuth);

const muteTargetSchema = z.enum(MUTE_WORD_TARGETS);

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
 *
 * This is the ONLY place the stored value is normalized, and it has to stay that
 * way: Postgres has no counterpart to a Mongoose `trim`/`lowercase` setter, so
 * the `(user_id, value)` unique constraint only dedupes what this function
 * already agreed to spell one way. (`MuteWord`'s Mongoose schema declared
 * neither setter, so nothing is being restored here — the normalization has
 * always lived at this call site, and the port must not let it drift back out.)
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

function serialize(row: typeof muteWords.$inferSelect): SerializedMuteWord {
  return {
    id: row.id,
    value: row.value,
    targets: row.targets.filter(isMuteTarget),
    actorTarget: row.actorTarget,
    createdAt: row.createdAt,
  };
}

/**
 * GET /mute-words
 * List the current user's muted words/hashtags (newest first).
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    // `created_at` is not unique, so the primary key breaks ties. This list is
    // capped at MAX_MUTE_WORDS_PER_USER and has no cursor, so the tiebreak buys
    // a stable order rather than protecting a page boundary.
    const rows = await getDb()
      .select()
      .from(muteWords)
      .where(eq(muteWords.userId, userId))
      .orderBy(desc(muteWords.createdAt), desc(muteWords.id));
    return sendSuccessResponse(res, 200, rows.map(serialize));
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

    const db = getDb();

    // Idempotency short-circuit: if it already exists, return it unchanged. The
    // insert below repeats the check atomically, so this read is the fast path,
    // not the guarantee.
    const [existing] = await db
      .select()
      .from(muteWords)
      .where(and(eq(muteWords.userId, userId), eq(muteWords.value, normalized.value)))
      .limit(1);
    if (existing) {
      return sendSuccessResponse(res, 200, serialize(existing), 'Muted word already exists');
    }

    // Enforce per-user cap. Deliberately AFTER the idempotency check: a repeat of
    // an entry the user already has must not be refused for being over the cap.
    const [total] = await db
      .select({ value: count() })
      .from(muteWords)
      .where(eq(muteWords.userId, userId));
    if ((total?.value ?? 0) >= MAX_MUTE_WORDS_PER_USER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can have at most ${MAX_MUTE_WORDS_PER_USER} muted words`,
      );
    }

    // `mute_words_user_id_value_key` settles the concurrent-insert race in the
    // statement itself, so there is no duplicate-key error to classify: an empty
    // `returning()` means another request won, and the winner is what we return.
    const [created] = await db
      .insert(muteWords)
      .values({
        userId,
        value: normalized.value,
        targets: normalized.targets,
        actorTarget: actorTarget ?? 'all',
      })
      .onConflictDoNothing({ target: [muteWords.userId, muteWords.value] })
      .returning();

    if (created) {
      return sendSuccessResponse(res, 201, serialize(created), 'Muted word created');
    }

    const [winner] = await db
      .select()
      .from(muteWords)
      .where(and(eq(muteWords.userId, userId), eq(muteWords.value, normalized.value)))
      .limit(1);
    if (winner) {
      return sendSuccessResponse(res, 200, serialize(winner), 'Muted word already exists');
    }
    // The winner was deleted between the conflict and this read. The Mongo
    // version rethrew here and answered 500; a new status code would be a wire
    // change on a path no client has ever seen, so the answer stays the same.
    logger.error('[MuteWords] Muted word vanished between conflict and re-read', {
      userId: req.user?.id,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to create muted word');
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

      // Built from literal COLUMN PROPERTY names, never from request keys:
      // drizzle keys `set()` by property name and silently ignores an unknown
      // one, so a mistyped key would write nothing and still answer 200.
      const update: { targets?: MuteTarget[]; actorTarget?: 'all' | 'exclude-following' } = {};
      if (targets) update.targets = targets;
      if (actorTarget) update.actorTarget = actorTarget;

      if (Object.keys(update).length === 0) {
        return sendErrorResponse(res, 400, 'Bad Request', 'Nothing to update');
      }

      const [updated] = await getDb()
        .update(muteWords)
        .set(update)
        .where(and(eq(muteWords.id, pathId(req.params.id)), eq(muteWords.userId, userId)))
        .returning();

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
    const [result] = await getDb()
      .delete(muteWords)
      .where(and(eq(muteWords.id, pathId(req.params.id)), eq(muteWords.userId, userId)))
      .returning({ id: muteWords.id });
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
