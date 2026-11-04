import { Router, type Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import type { PostSubscriptionItem, PostSubscriptionListResponse } from '@mention/shared-types';
import { getDb } from '../db/postgres';
import { postSubscriptions } from '../db/schema/engagement';
import { resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import type { CachedUserSummary } from '../services/userSummaryCache';
import { queryInt, queryString } from '../utils/queryParams';
import { chronoKeyset, decodeChronoCursor, encodeChronoCursor } from '../utils/chronoCursor';
import { logger } from '../utils/logger';

const router = Router();

/** Page size for `GET /subscriptions`. */
const DEFAULT_SUBSCRIPTION_PAGE_SIZE = 50;
const MAX_SUBSCRIPTION_PAGE_SIZE = 100;

// Get subscription status for the current user to an author
router.get('/:authorId/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const authorId = typeof req.params.authorId === 'string' ? req.params.authorId : undefined;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    const [existing] = await getDb()
      .select({ id: postSubscriptions.id })
      .from(postSubscriptions)
      .where(
        and(eq(postSubscriptions.subscriberId, userId), eq(postSubscriptions.authorId, authorId)),
      )
      .limit(1);
    return res.json({ subscribed: !!existing });
  } catch (error) {
    logger.error('[Subscriptions] Error checking subscription status:', {
      userId: req.user?.id,
      authorId: req.params.authorId,
      error,
    });
    return res.status(500).json({ message: 'Error checking subscription status' });
  }
});

// Subscribe current user to author posts
router.post('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const authorId = typeof req.params.authorId === 'string' ? req.params.authorId : undefined;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });
    if (authorId === userId)
      return res.status(400).json({ message: 'Cannot subscribe to yourself' });

    // `post_subscriptions_subscriber_id_author_id_key` makes the repeat a no-op
    // inside the statement.
    await getDb()
      .insert(postSubscriptions)
      .values({ subscriberId: userId, authorId })
      .onConflictDoNothing({
        target: [postSubscriptions.subscriberId, postSubscriptions.authorId],
      });
    return res.json({ subscribed: true });
  } catch (error: unknown) {
    logger.error('[Subscriptions] Error subscribing to author:', {
      userId: req.user?.id,
      authorId: req.params.authorId,
      error,
    });
    return res.status(500).json({ message: 'Error subscribing to author' });
  }
});

// Unsubscribe current user from author posts
router.delete('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const authorId = typeof req.params.authorId === 'string' ? req.params.authorId : undefined;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    await getDb()
      .delete(postSubscriptions)
      .where(
        and(eq(postSubscriptions.subscriberId, userId), eq(postSubscriptions.authorId, authorId)),
      );
    return res.json({ subscribed: false });
  } catch (error) {
    logger.error('[Subscriptions] Error unsubscribing from author:', {
      userId: req.user?.id,
      authorId: req.params.authorId,
      error,
    });
    return res.status(500).json({ message: 'Error unsubscribing from author' });
  }
});

/**
 * List the current user's activity subscriptions, newest first.
 *
 * GET /subscriptions?limit=&cursor=
 *
 * Each author is hydrated SERVER-SIDE through {@link resolveUserSummaries} — the
 * same batched, Redis-backed resolver feed hydration uses — so one page costs a
 * single bulk Oxy call for the cache misses instead of an `N+1` fan-out, and the
 * client receives the canonical Oxy {@link PostUser} rather than a bare id it
 * could not render. An author Oxy cannot resolve degrades to
 * {@link degradedActorSummary} (empty username, `'Unknown user'`) so a transient
 * lookup failure never surfaces a raw id as a handle.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const limit = Math.min(
      Math.max(queryInt(req.query.limit) || DEFAULT_SUBSCRIPTION_PAGE_SIZE, 1),
      MAX_SUBSCRIPTION_PAGE_SIZE,
    );
    // A malformed token yields the first page rather than an error.
    const cursor = decodeChronoCursor(queryString(req.query.cursor));

    const subscriberMatch = eq(postSubscriptions.subscriberId, userId);
    // `created_at` is not unique, so the page is the `(created_at, id)` pair —
    // matching the ORDER BY below exactly.
    const pageWhere = cursor
      ? and(subscriberMatch, chronoKeyset(postSubscriptions, cursor))
      : subscriberMatch;

    const rows = await getDb()
      .select()
      .from(postSubscriptions)
      .where(pageWhere)
      .orderBy(desc(postSubscriptions.createdAt), desc(postSubscriptions.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // One batched identity pass for the whole page. A whole-batch failure is not
    // fatal: every author falls back to its degraded summary so the list still
    // renders (and self-heals on the next fetch once Oxy recovers).
    const authorIds = Array.from(new Set(page.map((row) => row.authorId)));
    let summaries = new Map<string, CachedUserSummary>();
    if (authorIds.length > 0) {
      try {
        summaries = await resolveUserSummaries(authorIds);
      } catch (error) {
        logger.warn('[Subscriptions] Failed to resolve subscription authors', {
          userId,
          count: authorIds.length,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    const subscriptions: PostSubscriptionItem[] = page.map((row) => ({
      author: summaries.get(row.authorId)?.user ?? degradedActorSummary(row.authorId),
      createdAt: row.createdAt.toISOString(),
    }));

    const last = page[page.length - 1];
    const body: PostSubscriptionListResponse = { subscriptions };
    if (hasMore && last) {
      body.nextCursor = encodeChronoCursor(last.createdAt, last.id);
    }

    return res.json(body);
  } catch (error) {
    logger.error('[Subscriptions] Error listing subscriptions:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing subscriptions' });
  }
});

export default router;
