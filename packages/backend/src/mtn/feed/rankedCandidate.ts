/**
 * Ranked candidate helpers shared by the ranked feeds (ForYou, Explore, Videos,
 * Media).
 *
 * `FeedRankingService.rankPosts` decorates each lean Mongo document with a
 * `finalScore` number. {@link toRankedCandidate} preserves the full lean post
 * document while narrowing `_id` for score/cursor helpers.
 */

import { FeedPostSlice } from '@mention/shared-types';

/**
 * A ranked candidate post: a lean Mongo document decorated with `finalScore` by
 * FeedRankingService. `_id` is intentionally wide so engine {@link CandidatePost}
 * pools assign without casting; callers stringify via {@link readCandidateId}.
 */
export interface RankedCandidate {
  _id: { toString(): string };
  oxyUserId?: string;
  finalScore?: number;
}

export function readCandidateId(post: RankedCandidate): string {
  return post._id.toString();
}

function hasToString(value: object): value is { toString(): string } {
  return typeof Reflect.get(value, 'toString') === 'function';
}

/** Narrow a lean engine candidate to a ranked candidate when `_id` is stringifiable. */
export function toRankedCandidate<T extends { _id?: unknown; oxyUserId?: string; finalScore?: number }>(
  post: T,
): (Omit<T, '_id'> & RankedCandidate) | null {
  const id = post._id;
  if (id === null || id === undefined) return null;
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'boolean' || typeof id === 'bigint') {
    const text = String(id);
    return { ...post, _id: { toString: () => text } };
  }
  if (typeof id === 'object' && hasToString(id)) {
    return { ...post, _id: id };
  }
  return null;
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
 * a lean Mongo doc carrying `oxyUserId`, while a hydrated slice's `post` carries
 * a `user.id`. We read the hydrated id first and fall back to `oxyUserId` so the
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
    const rawId = Reflect.get(post, '_id');
    if (rawId !== null && rawId !== undefined) {
      const id = typeof rawId === 'object' && hasToString(rawId) ? rawId.toString() : String(rawId);
      if (id) return { score: finalScore, id };
    }
  }
  return undefined;
}
