import { describe, it, expect } from 'vitest';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

describe('FeedQueryBuilder.buildVideosQuery metadata filters', () => {
  it('requires complete video metadata with default min duration', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined);
    const and = query.$and as Array<Record<string, unknown>>;
    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    expect(mediaClause).toBeDefined();

    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch).toEqual({
      type: 'video',
      durationSec: { $gte: MtnConfig.videosFeed.minDurationSec },
      orientation: { $exists: true },
      width: { $gt: 0 },
      height: { $gt: 0 },
    });
  });

  it('applies orientation and minDuration overrides', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined, {
      orientation: 'portrait',
      minDurationSec: 30,
    });
    const and = query.$and as Array<Record<string, unknown>>;
    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch.orientation).toBe('portrait');
    expect(elemMatch.durationSec).toEqual({ $gte: 30 });
  });

  it('keeps public published non-boost base match', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined);
    expect(query.visibility).toBe(PostVisibility.PUBLIC);
    expect(query.status).toBe('published');
  });
});

describe('videos portrait-first sort predicate', () => {
  function hasPortraitVideo(post: { content?: { media?: Array<{ type?: string; orientation?: string }> } }): boolean {
    const media = post.content?.media;
    return Array.isArray(media)
      && media.some((item) => item.type === 'video' && item.orientation === 'portrait');
  }

  it('detects portrait from stored orientation field', () => {
    expect(hasPortraitVideo({
      content: { media: [{ type: 'video', orientation: 'portrait' }] },
    })).toBe(true);
    expect(hasPortraitVideo({
      content: { media: [{ type: 'video', orientation: 'landscape' }] },
    })).toBe(false);
  });

  it('sorts portrait candidates before landscape at equal score', () => {
    const posts = [
      { id: 'a', finalScore: 10, content: { media: [{ type: 'video', orientation: 'landscape' }] } },
      { id: 'b', finalScore: 10, content: { media: [{ type: 'video', orientation: 'portrait' }] } },
      { id: 'c', finalScore: 5, content: { media: [{ type: 'video', orientation: 'landscape' }] } },
    ];

    const sorted = [...posts].sort((a, b) => {
      const aPortrait = hasPortraitVideo(a) ? 1 : 0;
      const bPortrait = hasPortraitVideo(b) ? 1 : 0;
      if (bPortrait !== aPortrait) return bPortrait - aPortrait;
      return b.finalScore - a.finalScore;
    });

    expect(sorted.map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });
});
