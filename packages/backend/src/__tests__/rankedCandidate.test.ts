import { describe, it, expect } from 'vitest';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { sliceCursorAnchor, toRankedCandidate } from '../mtn/feed/rankedCandidate';

/**
 * A slice as it exists BEFORE hydration: `items[].post` is still the raw
 * candidate record, which is what `sliceCursorAnchor` reads. The cast mirrors
 * the placeholder `ThreadSlicingService.buildSlice` writes — hydration replaces
 * it with the real `HydratedPost` later.
 */
function rawSlice(posts: Array<Record<string, unknown>>): FeedPostSlice {
  return {
    _sliceKey: posts.map((post) => String(post.id)).join('+'),
    isIncompleteThread: false,
    items: posts.map((post) => ({
      post: post as unknown as HydratedPost,
      isThreadParent: false,
      isThreadChild: false,
      isThreadLastChild: false,
    })),
  };
}

describe('toRankedCandidate', () => {
  it('preserves post metadata needed by downstream feed steps', () => {
    const post = {
      id: 'abc123',
      oxyUserId: 'user-1',
      isReply: false,
      finalScore: 9,
      content: {
        media: [{ type: 'video', orientation: 'portrait' }],
      },
      createdAt: '2026-07-10T00:00:00.000Z',
    };

    const ranked = toRankedCandidate(post);
    expect(ranked).not.toBeNull();
    expect(ranked?.content).toEqual(post.content);
    expect(ranked?.createdAt).toBe(post.createdAt);
    expect(ranked?.finalScore).toBe(9);
    expect(ranked?.id).toBe('abc123');
  });

  it('carries the STORED reply discriminator through ranking', () => {
    // `ThreadSlicingService` asks the reply question after scoring, so a lost
    // `isReply` there re-promotes an orphaned reply into the root feeds.
    expect(toRankedCandidate({ id: 'r1', oxyUserId: 'u', isReply: true })?.isReply).toBe(true);
    expect(toRankedCandidate({ id: 'p1', oxyUserId: 'u', isReply: false })?.isReply).toBe(false);
  });

  it('drops a candidate that cannot be cursored on rather than cursoring to an empty string', () => {
    expect(toRankedCandidate({ oxyUserId: 'u', isReply: false })).toBeNull();
    expect(toRankedCandidate({ id: '', oxyUserId: 'u', isReply: false })).toBeNull();
  });
});

describe('sliceCursorAnchor', () => {
  it('reads the score and id off the ranked item', () => {
    const slice = rawSlice([{ id: 'lean-id', oxyUserId: 'user-1', finalScore: 12 }]);
    expect(sliceCursorAnchor(slice)).toEqual({ score: 12, id: 'lean-id' });
  });

  it('skips slice items that were never ranked (a reply-context parent)', () => {
    // The parent is fetched by the slicer, not by the ranked source, so it has
    // no `finalScore`. Anchoring on it would collapse the watermark to 0 and
    // break score-descending pagination.
    const slice = rawSlice([
      { id: 'parent-id', oxyUserId: 'user-2' },
      { id: 'ranked-id', oxyUserId: 'user-1', finalScore: 12 },
    ]);
    expect(sliceCursorAnchor(slice)).toEqual({ score: 12, id: 'ranked-id' });
  });

  it('returns undefined when no item in the slice carries a score', () => {
    expect(sliceCursorAnchor(rawSlice([{ id: 'unranked', oxyUserId: 'user-1' }]))).toBeUndefined();
  });

  it('returns undefined when the ranked item has no usable id', () => {
    // Ids are plain strings now — Mongo's three runtime id shapes (ObjectId,
    // string, aggregation `{toString()}`) collapsed to one, so there is nothing
    // left to coerce and an unusable id must not become a cursor.
    expect(sliceCursorAnchor(rawSlice([{ oxyUserId: 'user-1', finalScore: 12 }]))).toBeUndefined();
    expect(
      sliceCursorAnchor(rawSlice([{ id: '', oxyUserId: 'user-1', finalScore: 12 }])),
    ).toBeUndefined();
  });
});
