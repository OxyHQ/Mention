import { Router, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type {
  PostSubscriptionItem,
  PostSubscriptionListResponse,
} from '@mention/shared-types';
import PostSubscription, { type IPostSubscription } from '../models/PostSubscription';
import { resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import type { CachedUserSummary } from '../services/userSummaryCache';
import { queryInt, queryString } from '../utils/queryParams';
import { logger } from '../utils/logger';

const router = Router();

/** Page size for `GET /subscriptions`. */
const DEFAULT_SUBSCRIPTION_PAGE_SIZE = 50;
const MAX_SUBSCRIPTION_PAGE_SIZE = 100;

/**
 * The keyset a subscription page resumes from.
 *
 * `createdAt` alone is NOT unique — two subscriptions made in the same
 * millisecond would straddle a page boundary and be skipped or repeated — so the
 * cursor carries the document id as the tie-break, matching the
 * `{ createdAt: -1, _id: -1 }` sort exactly.
 */
interface SubscriptionCursor {
  createdAt: Date;
  id: Types.ObjectId;
}

/** `<epochMillis>_<objectId>` — opaque to the client, cheap to parse here. */
function encodeSubscriptionCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}_${id}`;
}

/**
 * Parse a client-supplied cursor. A malformed token yields `undefined` (⇒ the
 * first page) rather than an error: a tampered cursor must never turn into a
 * Mongoose CastError and a 500, which is why the id half is validated as an
 * ObjectId here and not left for the query to cast.
 */
function parseSubscriptionCursor(raw: string | undefined): SubscriptionCursor | undefined {
  if (!raw) return undefined;
  const separator = raw.indexOf('_');
  if (separator <= 0) return undefined;

  const millis = Number.parseInt(raw.slice(0, separator), 10);
  if (!Number.isFinite(millis)) return undefined;
  const createdAt = new Date(millis);
  if (Number.isNaN(createdAt.getTime())) return undefined;

  const id = raw.slice(separator + 1);
  if (!Types.ObjectId.isValid(id)) return undefined;

  return { createdAt, id: new Types.ObjectId(id) };
}

// Get subscription status for the current user to an author
router.get('/:authorId/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    const exists = await PostSubscription.exists({ subscriberId: userId, authorId });
    return res.json({ subscribed: !!exists });
  } catch (error) {
    logger.error('[Subscriptions] Error checking subscription status:', { userId: req.user?.id, authorId: req.params.authorId, error });
    return res.status(500).json({ message: 'Error checking subscription status' });
  }
});

// Subscribe current user to author posts
router.post('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });
    if (authorId === userId) return res.status(400).json({ message: 'Cannot subscribe to yourself' });

    await PostSubscription.updateOne(
      { subscriberId: userId, authorId },
      { $setOnInsert: { subscriberId: userId, authorId } },
      { upsert: true }
    );
    return res.json({ subscribed: true });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return res.json({ subscribed: true });
    }
    logger.error('[Subscriptions] Error subscribing to author:', { userId: req.user?.id, authorId: req.params.authorId, error });
    return res.status(500).json({ message: 'Error subscribing to author' });
  }
});

// Unsubscribe current user from author posts
router.delete('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    await PostSubscription.deleteOne({ subscriberId: userId, authorId });
    return res.json({ subscribed: false });
  } catch (error) {
    logger.error('[Subscriptions] Error unsubscribing from author:', { userId: req.user?.id, authorId: req.params.authorId, error });
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
    const cursor = parseSubscriptionCursor(queryString(req.query.cursor));

    const query: FilterQuery<IPostSubscription> = { subscriberId: userId };
    if (cursor) {
      query.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ];
    }

    const docs = await PostSubscription.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    // One batched identity pass for the whole page. A whole-batch failure is not
    // fatal: every author falls back to its degraded summary so the list still
    // renders (and self-heals on the next fetch once Oxy recovers).
    const authorIds = Array.from(new Set(page.map((doc) => doc.authorId)));
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

    const subscriptions: PostSubscriptionItem[] = page.map((doc) => ({
      author: summaries.get(doc.authorId)?.user ?? degradedActorSummary(doc.authorId),
      createdAt: doc.createdAt.toISOString(),
    }));

    const last = page[page.length - 1];
    const body: PostSubscriptionListResponse = { subscriptions };
    if (hasMore && last) {
      body.nextCursor = encodeSubscriptionCursor(last.createdAt, String(last._id));
    }

    return res.json(body);
  } catch (error) {
    logger.error('[Subscriptions] Error listing subscriptions:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing subscriptions' });
  }
});

export default router;
