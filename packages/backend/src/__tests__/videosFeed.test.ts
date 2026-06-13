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
  content: { text?: string; media?: Array<{ id: string; type: string }> };
  federation?: { activityId: string };
  boostOf?: string | null;
}

/**
 * Pure predicate that mirrors FeedQueryBuilder.buildVideosQuery's semantics so
 * we can assert inclusion/exclusion without a live MongoDB. Kept in lockstep
 * with the query: public + published, not a boost, and contains a video either
 * by post type or by a video item in content.media.
 */
function matchesVideosFeed(post: SamplePost): boolean {
  if (post.visibility !== PostVisibility.PUBLIC) return false;
  if (post.status !== 'published') return false;
  if (post.boostOf) return false;
  const isVideoType = post.type === PostType.VIDEO;
  const hasVideoMedia = Array.isArray(post.content.media)
    && post.content.media.some((m) => m.type === 'video');
  return isVideoType || hasVideoMedia;
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
  it('matches video posts by type OR a video item in content.media', () => {
    const query = FeedQueryBuilder.buildVideosQuery([], undefined);

    expect(query.visibility).toBe(PostVisibility.PUBLIC);
    expect(query.status).toBe('published');

    const and = query.$and as Array<Record<string, unknown>>;
    expect(Array.isArray(and)).toBe(true);

    const videoClause = and.find((c) => Array.isArray(c.$or)
      && (c.$or as Array<Record<string, unknown>>).some((o) => o.type === PostType.VIDEO));
    expect(videoClause).toBeDefined();

    const orConditions = (videoClause?.$or ?? []) as Array<Record<string, unknown>>;
    expect(orConditions).toContainEqual({ type: PostType.VIDEO });
    expect(orConditions).toContainEqual({ 'content.media': { $elemMatch: { type: 'video' } } });
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
  const nativeVideo: SamplePost = {
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'native clip', media: [{ id: 'm1', type: 'video' }] },
  };

  const federatedVideo: SamplePost = {
    // Federated posts often arrive typed as IMAGE/TEXT but carry a video in
    // content.media — they must still be included.
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'remote clip', media: [{ id: 'm2', type: 'video' }] },
    federation: { activityId: 'https://remote.example/users/alice/statuses/1' },
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
});
