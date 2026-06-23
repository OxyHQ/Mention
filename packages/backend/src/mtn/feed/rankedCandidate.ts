/**
 * Ranked candidate helpers shared by the ranked feeds (ForYou, Explore, Videos,
 * Media).
 *
 * `FeedRankingService.rankPosts` decorates each lean Mongo document with a
 * `finalScore` number. These readers capture only the fields the feed code reads
 * directly so the feeds avoid `any` while leaving the rich post body opaque.
 */

import mongoose from 'mongoose';
import { FeedPostSlice } from '@mention/shared-types';

/**
 * A ranked candidate post: a lean Mongo document decorated with `finalScore` by
 * FeedRankingService.
 */
export interface RankedCandidate {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
  finalScore?: number;
}

export function readCandidateId(post: RankedCandidate): string {
  return post._id.toString();
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
  const rawAuthor = (anchor as { oxyUserId?: string }).oxyUserId;
  return rawAuthor || undefined;
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
    const post = item.post as { finalScore?: number; id?: string; _id?: { toString(): string } } | undefined;
    if (!post || post.finalScore === undefined) continue;
    const id = post.id ?? post._id?.toString();
    if (!id) continue;
    return { score: post.finalScore, id };
  }
  return undefined;
}
