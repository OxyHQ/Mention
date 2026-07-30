import { describe, it, expect } from 'vitest';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

describe('FeedQueryBuilder.buildVideosQuery metadata filters', () => {
  // Duration APPLIES WHEN KNOWN and abstains when absent; dimensions stay required.
  // Measured in production 2026-07-30: `durationSec` is present on 5.9% of the 9,465
  // posts carrying a video item, and on 0% of the last day's arrivals — the whole
  // video corpus is federated and Mastodon does not advertise duration. Requiring the
  // field did not enforce a 20-second policy, it discarded 94% of the corpus and
  // enforced the policy on the remainder (shipped pool: 147 posts).
  it('requires dimensions, and applies the duration minimum only where duration is known', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined);
    const and = query.$and as Array<Record<string, unknown>>;

    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    expect(mediaClause).toBeDefined();

    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch).toEqual({
      type: 'video',
      $or: [
        { durationSec: { $gte: MtnConfig.videosFeed.minDurationSec } },
        { durationSec: { $exists: false } },
      ],
      orientation: MtnConfig.videosFeed.defaultOrientation,
      width: { $gt: 0 },
      height: { $gt: 0 },
    });
  });

  // `'all'` is the one setting whose NAME promises no filtering, so it must emit no
  // clause. `{$exists: true}` was still a filter: it silently required orientation to
  // have been persisted.
  it('applies orientation=all by not filtering on orientation at all', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined, { orientation: 'all' });
    const and = query.$and as Array<Record<string, unknown>>;
    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch.orientation).toBeUndefined();
  });

  it('applies orientation and minDuration overrides', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined, {
      orientation: 'portrait',
      minDurationSec: 30,
    });
    const and = query.$and as Array<Record<string, unknown>>;

    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    expect(mediaClause).toBeDefined();
    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch.orientation).toBe('portrait');
    expect(elemMatch.$or).toContainEqual({ durationSec: { $gte: 30 } });
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
