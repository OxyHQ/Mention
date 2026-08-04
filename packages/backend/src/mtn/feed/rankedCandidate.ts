/**
 * Ranked candidate helpers shared by the ranked feeds (ForYou, Explore, Videos,
 * Media).
 *
 * `FeedRankingService.rankPosts` decorates each post record with a `finalScore`
 * number. {@link toRankedCandidate} preserves the whole record while asserting
 * the id every score/cursor helper needs.
 */

import { FeedPostSlice } from '@mention/shared-types';

/**
 * A ranked candidate post: a post record decorated with `finalScore` by
 * FeedRankingService.
 */
export interface RankedCandidate {
  id: string;
  oxyUserId?: string | null;
  finalScore?: number;
  /**
   * Written as a reply — the STORED discriminator, carried through ranking
   * because `ThreadSlicingService` asks the question after scoring and must not
   * re-derive it from `parentPostId` (which `ON DELETE SET NULL` can clear).
   */
  isReply: boolean;
}

export function readCandidateId(post: RankedCandidate): string {
  return post.id;
}

/**
 * Narrow a candidate to a ranked candidate — i.e. assert it has an id.
 *
 * This used to do real work, and it is worth recording what that work WAS so
 * nobody re-adds it. Mongo handed feed candidates ids of three different runtime
 * shapes (an `ObjectId`, a `string`, or an opaque `{ toString() }` from an
 * aggregation), so every score/cursor helper had to accept `_id: unknown` and
 * this function existed to coerce them into something stringifiable.
 *
 * `PostRecord.id` is a `string`, always. The three shapes collapse to one, so
 * the coercion is gone and only the presence check remains — a candidate with no
 * id cannot be cursored on and is dropped rather than silently cursored to `''`.
 */
export function toRankedCandidate<T extends { id?: string; oxyUserId?: string | null; finalScore?: number; isReply: boolean }>(
  post: T,
): (T & RankedCandidate) | null {
  const id = post.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { ...post, id };
}

export function readCandidateScore(post: RankedCandidate): number {
  return post.finalScore ?? 0;
}

/**
 * The author key for a feed slice = the slice's PRIMARY author (the author of
 * its anchor post, i.e. the first item). Diversifying slices by this key keeps a
 * multi-post thread intact (it is one slice / one unit) while still spacing
 * different slices by the same author. Returns `undefined` when the author can't
 * be resolved (treated as conflict-free by the reranker).
 *
 * Works on BOTH raw (pre-hydration) and hydrated slices: a raw slice's `post` is
 * a post record carrying `oxyUserId`, while a hydrated slice's `post` carries a
 * `user.id`. We read the hydrated id first and fall back to `oxyUserId` so the
 * reranker can run before OR after hydration.
 */
export function sliceAuthorKey(slice: FeedPostSlice): string | undefined {
  const anchor = slice.items[0]?.post;
  if (!anchor) return undefined;
  const hydratedId = anchor.user?.id;
  if (hydratedId) return hydratedId;
  if ('oxyUserId' in anchor && typeof Reflect.get(anchor, 'oxyUserId') === 'string') {
    const rawAuthor = Reflect.get(anchor, 'oxyUserId');
    return typeof rawAuthor === 'string' && rawAuthor.length > 0 ? rawAuthor : undefined;
  }
  return undefined;
}

/**
 * Whether a feed slice ORIGINATED from a DISCOVERY lane — its anchor post carries
 * the opaque `_discovery` marker stamped by `FeedEngine.gatherPool` on candidates
 * from non-trusted sources. Read by `capDiscoveryShare` to bound the discovery
 * share of a ranked For You page. Only RAW (pre-hydration) slices carry the marker
 * (hydration builds a fresh DTO that drops engine bookkeeping) — which is exactly
 * where the cap runs. Returns `false` for slices with no anchor or no marker
 * (treated as trusted, so they are never deferred).
 */
export function sliceIsDiscovery(slice: FeedPostSlice): boolean {
  const anchor = slice.items[0]?.post;
  if (!anchor || typeof anchor !== 'object') return false;
  return Reflect.get(anchor, '_discovery') === true;
}

/**
 * The score-cursor anchor of a slice: the RANKED candidate item within the slice
 * — the one decorated with a `finalScore` by FeedRankingService. A slice may also
 * contain non-ranked items (a reply-context PARENT or a thread CHILD fetched
 * separately by ThreadSlicingService) which have NO `finalScore`; those must be
 * ignored for cursoring or they would collapse the watermark to 0 and break
 * score-descending pagination. Returns the ranked item's `{ score, id }`, or
 * `undefined` when the slice has no ranked item (defensive — should not happen
 * since every slice is seeded by a ranked feed post).
 */
export function sliceCursorAnchor(slice: FeedPostSlice): { score: number; id: string } | undefined {
  for (const item of slice.items) {
    const post = item.post;
    if (!post || typeof post !== 'object') continue;
    const finalScore = Reflect.get(post, 'finalScore');
    if (typeof finalScore !== 'number') continue;
    const idField = Reflect.get(post, 'id');
    if (typeof idField === 'string' && idField.length > 0) {
      return { score: finalScore, id: idField };
    }
  }
  return undefined;
}
