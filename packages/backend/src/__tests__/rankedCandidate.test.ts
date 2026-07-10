import { describe, it, expect } from 'vitest';
import { sliceCursorAnchor, toRankedCandidate } from '../mtn/feed/rankedCandidate';
import type { FeedPostSlice } from '@mention/shared-types';

describe('toRankedCandidate', () => {
  it('preserves post metadata needed by downstream feed steps', () => {
    const post = {
      _id: 'abc123',
      oxyUserId: 'user-1',
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
    expect(ranked?._id.toString()).toBe('abc123');
  });
});

describe('sliceCursorAnchor', () => {
  it('extracts cursor anchor when ranked post only has a string _id', () => {
    const slice: FeedPostSlice = {
      _sliceKey: 'ranked-only',
      isIncompleteThread: false,
      items: [{
        post: {
          _id: 'lean-id',
          oxyUserId: 'user-1',
          finalScore: 12,
        } as never,
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: false,
      }],
    };

    expect(sliceCursorAnchor(slice)).toEqual({ score: 12, id: 'lean-id' });
  });

  it('extracts cursor anchor when ranked post _id is numeric', () => {
    const slice: FeedPostSlice = {
      _sliceKey: 'numeric-id',
      isIncompleteThread: false,
      items: [{
        post: {
          _id: 42,
          oxyUserId: 'user-1',
          finalScore: 7,
        } as never,
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: false,
      }],
    };

    expect(sliceCursorAnchor(slice)).toEqual({ score: 7, id: '42' });
  });
});
