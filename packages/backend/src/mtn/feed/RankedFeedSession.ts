import { EXPLORE_RANKING_VERSION } from './CursorBuilder';
import { createHash, randomUUID } from 'node:crypto';
import { getRedisClient } from '../../utils/redis';
import { withRedisFallback } from '../../utils/redisHelpers';
import { ApiError } from '../../utils/error';
import type { FeedDefinition, FeedEngineContext } from './engine/types';

export const RANKED_SESSION_TTL_MS = 30 * 60 * 1000;
export const RANKED_SESSION_MAX_SCANNED = 5000;

export interface RankedSessionCandidate {
  id: string;
  score: number;
  discovery: boolean;
  socialOnly?: boolean;
}

/** Only identities, ranking metadata and source progress are cached, never bodies. */
export interface RankedFeedSession {
  binding: string;
  sessionId?: string;
  asOf: number;
  expiresAt: number;
  pending: RankedSessionCandidate[];
  scannedIds: string[];
  /** Keep the scan budget monotonic when revocations release IDs for independent lanes. */
  retiredSocialCount?: number;
  initialSeenIds: string[];
  deliveredIds: string[];
  sourceCursors: Record<string, string | undefined>;
  exhaustedSources: string[];
  phase: 'ranked' | 'popular';
}

export function expiredFeedCursor(): ApiError {
  return new ApiError(
    410,
    'Feed pagination session expired; refresh the feed',
    'FEED_CURSOR_EXPIRED',
  );
}

export function isRankedSessionCursor(cursor?: string): boolean {
  return cursor?.startsWith('fs1:') === true;
}

/** Bind pagination to the actual definition and the reader's selection. */
export function rankedSessionBinding(
  definition: FeedDefinition,
  ctx: FeedEngineContext,
  limit: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        definition,
        ...(definition.id === 'explore' ? { scoreRevision: EXPLORE_RANKING_VERSION } : {}),
        ...(definition.id === 'for_you' || definition.id === 'friends_popular'
          ? { socialEvidenceRevision: 1 }
          : {}),
        limit,
        viewer: ctx.currentUserId ?? null,
        settings: ctx.feedSettings,
        tuning: ctx.feedTuning,
        video: ctx.videoFilters,
        languages: ctx.viewerBaseLanguages,
        sensitive: ctx.showSensitiveContent,
        negatives: {
          hiddenAuthors: [...new Set(ctx.userBehavior?.hiddenAuthors ?? [])].sort(),
          mutedAuthors: [...new Set(ctx.userBehavior?.mutedAuthors ?? [])].sort(),
          blockedAuthors: [...new Set(ctx.userBehavior?.blockedAuthors ?? [])].sort(),
          hiddenTopics: [
            ...new Set((ctx.userBehavior?.hiddenTopics ?? []).map((topic) => topic.toLowerCase())),
          ].sort(),
          excludedAuthors: [...new Set(ctx.excludedAuthorIds ?? [])].sort(),
          privacyBlocked: [...new Set(ctx.viewerPrivacy?.blockedIds ?? [])].sort(),
        },
        activitySubscriptions: [...new Set(ctx.activitySubscribedAuthorIds ?? [])].sort(),
        following: ctx.followingIds ? [...new Set(ctx.followingIds)].sort() : [],
        lists: ctx.subscribedListMemberIds ? [...new Set(ctx.subscribedListMemberIds)].sort() : [],
        communities: ctx.followedCommunityIds ? [...new Set(ctx.followedCommunityIds)].sort() : [],
        mutedLanes: ctx.mutedLaneIds ? [...new Set(ctx.mutedLaneIds)].sort() : [],
      }),
    )
    .digest('hex');
}

// Keep only the three most recent immutable snapshots per session. Trimming
// and writing are atomic, including concurrent page retries. Earlier cursors
// explicitly expire instead of retaining quadratic history during deep scroll.
export const WRITE_RANKED_SESSION = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('LPUSH', KEYS[2], KEYS[1])
local expired = redis.call('LRANGE', KEYS[2], 3, -1)
for _, key in ipairs(expired) do redis.call('DEL', key) end
redis.call('LTRIM', KEYS[2], 0, 2)
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

export class RankedFeedSessionStore {
  available(): boolean {
    return getRedisClient().isReady;
  }

  async load(cursor: string, binding: string): Promise<RankedFeedSession> {
    if (!/^fs1:[0-9a-f-]{36}$/.test(cursor)) throw expiredFeedCursor();
    const data = await withRedisFallback(
      getRedisClient(),
      () => getRedisClient().get(`feed:session:${cursor}`),
      null,
      'readRankedFeedSession',
    );
    if (!data) throw expiredFeedCursor();
    try {
      const state: RankedFeedSession = JSON.parse(data);
      if (
        state.binding !== binding ||
        state.expiresAt <= Date.now() ||
        !Array.isArray(state.pending) ||
        !Array.isArray(state.scannedIds)
      )
        throw expiredFeedCursor();
      return state;
    } catch {
      throw expiredFeedCursor();
    }
  }

  /** Preserve source progress across continuations; live records are revalidated on replay. */
  async save(state: RankedFeedSession): Promise<string> {
    const ttl = Math.ceil((state.expiresAt - Date.now()) / 1000);
    if (
      ttl <= 0 ||
      state.scannedIds.length + (state.retiredSocialCount ?? 0) > RANKED_SESSION_MAX_SCANNED
    )
      throw expiredFeedCursor();
    state.sessionId ??= randomUUID();
    const cursor = `fs1:${randomUUID()}`;
    const saved = await withRedisFallback(
      getRedisClient(),
      async () => {
        await getRedisClient().eval(WRITE_RANKED_SESSION, {
          keys: [`feed:session:${cursor}`, `feed:session:history:${state.sessionId}`],
          arguments: [JSON.stringify(state), String(ttl)],
        });
        return true;
      },
      false,
      'writeRankedFeedSession',
    );
    if (!saved) throw expiredFeedCursor();
    return cursor;
  }
}

export const rankedFeedSessionStore = new RankedFeedSessionStore();
