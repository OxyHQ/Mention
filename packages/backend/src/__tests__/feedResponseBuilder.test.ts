import { describe, it, expect } from 'vitest';
import { FeedResponseBuilder } from '../utils/FeedResponseBuilder';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';

/**
 * Build N slices where each slice contains `postsPerSlice` posts. Thread slicing
 * groups multiple posts into a single slice, so `slices.length` is routinely
 * smaller than the post count returned by the underlying query.
 */
function makeSlices(sliceCount: number, postsPerSlice = 1): FeedPostSlice[] {
  return Array.from({ length: sliceCount }, (_, sliceIdx) => ({
    _sliceKey: `slice-${sliceIdx}`,
    isIncompleteThread: false,
    items: Array.from({ length: postsPerSlice }, (_, postIdx) => ({
      post: { id: `post-${sliceIdx}-${postIdx}` } as HydratedPost,
      isThreadParent: postsPerSlice > 1 && postIdx === 0,
      isThreadChild: postsPerSlice > 1 && postIdx > 0,
      isThreadLastChild: postsPerSlice > 1 && postIdx === postsPerSlice - 1,
    })),
  }));
}

describe('FeedResponseBuilder.buildSlicedResponse', () => {
  it('honors the caller hasMore + cursor even when slices collapse below limit', () => {
    // Mirrors the explore feed: the query overfetched (hasMore=true) and produced
    // a valid advancing cursor, but thread grouping collapsed 20 posts into 18
    // slices, so slices.length (18) < limit (20). hasMore MUST stay true so
    // infinite scroll keeps paginating.
    const result = FeedResponseBuilder.buildSlicedResponse({
      slices: makeSlices(18),
      limit: 20,
      cursorFromLastSlice: 'score:abc',
      hasMore: true,
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('score:abc');
    expect(result.items).toHaveLength(18);
  });

  it('stops pagination when the caller reports no more data', () => {
    const result = FeedResponseBuilder.buildSlicedResponse({
      slices: makeSlices(12),
      limit: 20,
      cursorFromLastSlice: 'score:abc',
      hasMore: false,
    });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('stops pagination when there is more data but no advancing cursor', () => {
    // hasMore=true but the cursor could not advance (e.g. duplicate score/id) →
    // pagination must terminate to avoid an infinite loop on the same page.
    const result = FeedResponseBuilder.buildSlicedResponse({
      slices: makeSlices(20),
      limit: 20,
      previousCursor: 'score:abc',
      cursorFromLastSlice: 'score:abc', // does not advance
      hasMore: true,
    });

    expect(result.nextCursor).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });

  it('paginates a full page of single-post slices', () => {
    const result = FeedResponseBuilder.buildSlicedResponse({
      slices: makeSlices(20),
      limit: 20,
      cursorFromLastSlice: 'score:def',
      hasMore: true,
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('score:def');
    expect(result.items).toHaveLength(20);
  });
});
