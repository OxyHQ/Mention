/**
 * A COMPLETE {@link CandidatePost} for the in-memory feed suites.
 *
 * Every feed module — filter predicates, the engine merge, the discovery gate,
 * the offline eval harness — now receives a `PostRecord`, a declared shape
 * rather than the `Record<string, unknown>` bag the Mongo lean document was. A
 * partial literal papered over with a cast is exactly what let the old fixtures
 * keep saying `_id` long after nothing read it, so the base here is whole and
 * overrides are a shallow merge on top of it.
 *
 * `classification()` and `postStats()` exist for the same reason: both
 * sub-objects are required in full, and a caller that only cares about
 * `sensitive: true` must not have to restate the other nine fields (nor be
 * tempted to cast).
 */

import { PostType, PostVisibility } from '@mention/shared-types';
import type { PostStats } from '@mention/shared-types';
import type { PostRecordClassification } from '../../db/posts/postRecord';
import type { CandidatePost } from '../../mtn/feed/engine/types';

/** All-zero engagement, overridden per case. */
export function postStats(overrides: Partial<PostStats> = {}): PostStats {
  return {
    likesCount: 0,
    downvotesCount: 0,
    boostsCount: 0,
    federatedBoostsCount: 0,
    commentsCount: 0,
    viewsCount: 0,
    sharesCount: 0,
    savesCount: 0,
    ...overrides,
  };
}

/**
 * A classification subdocument in its DEFAULT (never-scored) state: `pending`,
 * all scores zero and no version marker, which `readTrustedScores` treats as
 * "no usable signal". Pass `status: 'classified'` or a current `version` to make
 * the scores trusted.
 */
export function classification(
  overrides: Partial<PostRecordClassification> = {},
): PostRecordClassification {
  return {
    status: 'pending',
    attempts: 0,
    sentiment: 'neutral',
    intent: 'other',
    confidence: 0,
    ...overrides,
    scores: {
      toxicity: 0,
      constructiveness: 0,
      spam: 0,
      quality: 0,
      controversy: 0,
      negativity: 0,
      ...overrides.scores,
    },
  };
}

/** A published, public, top-level text post by `author-1`. */
export function feedCandidate(overrides: Partial<CandidatePost> = {}): CandidatePost {
  return {
    id: 'post-1',
    oxyUserId: 'author-1',
    authorship: [{ oxyUserId: 'author-1', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    isReply: false,
    hasLinks: false,
    isEdited: false,
    hashtags: [],
    editHistory: [],
    replyPermission: ['anyone'],
    reviewReplies: false,
    quotesDisabled: false,
    boostOf: null,
    quoteOf: null,
    parentPostId: null,
    threadId: null,
    scheduledFor: null,
    content: { variants: [{ source: 'author', text: 'a post body' }] },
    mentions: [],
    stats: postStats(),
    metadata: {},
    postClassification: classification(),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}
