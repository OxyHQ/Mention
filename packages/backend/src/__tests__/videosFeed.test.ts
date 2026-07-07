import { describe, it, expect } from 'vitest';
import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  PostType,
  PostVisibility,
} from '@mention/shared-types';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

/**
 * Minimal post shape used to exercise the videos-feed match criteria.
 * Mirrors the relevant fields of a lean Post document.
 */
interface SamplePost {
  type: string;
  visibility: string;
  status: string;
  content: {
    text?: string;
    media?: Array<{
      id: string;
      type: string;
      width?: number;
      height?: number;
      durationSec?: number;
      orientation?: string;
    }>;
  };
  federation?: { activityId: string };
  boostOf?: string | null;
}

/**
 * Pure predicate that mirrors FeedQueryBuilder.buildVideosQuery's semantics so
 * we can assert inclusion/exclusion without a live MongoDB. Post-backfill:
 * public + published, not a boost, and a video item with complete metadata.
 */
function matchesVideosFeed(post: SamplePost): boolean {
  if (post.visibility !== PostVisibility.PUBLIC) return false;
  if (post.status !== 'published') return false;
  if (post.boostOf) return false;
  const media = post.content.media;
  if (!Array.isArray(media)) return false;
  return media.some((m) =>
    m.type === 'video'
    && typeof m.durationSec === 'number'
    && m.durationSec >= 20
    && m.orientation !== undefined
    && typeof m.width === 'number'
    && m.width > 0
    && typeof m.height === 'number'
    && m.height > 0,
  );
}

describe('videos feed descriptor', () => {
  it('recognizes "videos" as a valid feed descriptor', () => {
    expect(isValidFeedDescriptor('videos')).toBe(true);
  });

  it('parses the "videos" descriptor with no params', () => {
    const parsed = parseFeedDescriptor('videos');
    expect(parsed.source).toBe('videos');
    expect(parsed.params).toEqual([]);
  });
});

describe('FeedQueryBuilder.buildVideosQuery', () => {
  it('requires complete video metadata with default min duration', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined);

    expect(query.visibility).toBe(PostVisibility.PUBLIC);
    expect(query.status).toBe('published');

    const and = query.$and as Array<Record<string, unknown>>;
    expect(Array.isArray(and)).toBe(true);

    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    expect(mediaClause).toBeDefined();
    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch.type).toBe('video');
    expect(elemMatch.durationSec).toEqual({ $gte: 20 });
    expect(elemMatch.orientation).toEqual({ $exists: true });
  });

  it('excludes boosts and seen posts, and applies a cursor', () => {
    const cursor = '65fdc8c8c8c8c8c8c8c8c8c8';
    const seen = ['65aaaaaaaaaaaaaaaaaaaaaa'];
    const query = FeedQueryBuilder.buildVideosQuery(seen, cursor);
    const and = query.$and as Array<Record<string, unknown>>;

    // Boost exclusion clause is present.
    const boostClause = and.find((c) => Array.isArray(c.$or)
      && (c.$or as Array<Record<string, unknown>>).some((o) => o.boostOf === null));
    expect(boostClause).toBeDefined();

    // Seen-post exclusion ($nin) and cursor ($lt) clauses are present.
    const ninClause = and.find((c) => {
      const id = c._id as { $nin?: unknown[] } | undefined;
      return Array.isArray(id?.$nin);
    });
    expect(ninClause).toBeDefined();

    const ltClause = and.find((c) => {
      const id = c._id as { $lt?: unknown } | undefined;
      return id?.$lt !== undefined;
    });
    expect(ltClause).toBeDefined();
  });
});

describe('videos feed candidate selection', () => {
  const completeVideoMedia = {
    id: 'm1',
    type: 'video',
    width: 1080,
    height: 1920,
    durationSec: 30,
    orientation: 'portrait',
  };

  const nativeVideo: SamplePost = {
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'native clip', media: [completeVideoMedia] },
  };

  const federatedVideo: SamplePost = {
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'remote clip', media: [{ ...completeVideoMedia, id: 'm2' }] },
    federation: { activityId: 'https://remote.example/users/alice/statuses/1' },
  };

  const incompleteVideo: SamplePost = {
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'missing metadata', media: [{ id: 'm3', type: 'video' }] },
  };

  const textOnly: SamplePost = {
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'just text' },
  };

  it('includes a native video post', () => {
    expect(matchesVideosFeed(nativeVideo)).toBe(true);
  });

  it('includes a federated-shaped video post (no federation exclusion)', () => {
    expect(matchesVideosFeed(federatedVideo)).toBe(true);
  });

  it('excludes a text-only post', () => {
    expect(matchesVideosFeed(textOnly)).toBe(false);
  });

  it('excludes video posts missing persisted metadata', () => {
    expect(matchesVideosFeed(incompleteVideo)).toBe(false);
  });
});
