import { describe, it, expect } from 'vitest';
import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  PostType,
  PostVisibility,
} from '@mention/shared-types';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

/**
 * Minimal post shape used to exercise the media-feed match criteria.
 * Mirrors the relevant fields of a lean Post document.
 */
interface SamplePost {
  type: string;
  visibility: string;
  status: string;
  content: {
    text?: string;
    media?: Array<{ id: string; type: string }>;
    attachments?: Array<{ type: string; mediaType?: string }>;
  };
  federation?: { activityId: string };
  boostOf?: string | null;
}

/**
 * Pure predicate that mirrors FeedQueryBuilder.buildMediaFeedQuery's semantics
 * so we can assert inclusion/exclusion without a live MongoDB. Kept in lockstep
 * with the query: public + published, not a boost, and carries at least one
 * media attachment — by post type (IMAGE/VIDEO), a non-empty content.media
 * array, or a media item in content.attachments.
 */
function matchesMediaFeed(post: SamplePost): boolean {
  if (post.visibility !== PostVisibility.PUBLIC) return false;
  if (post.status !== 'published') return false;
  if (post.boostOf) return false;
  const isMediaType = post.type === PostType.IMAGE || post.type === PostType.VIDEO;
  const hasMediaArray = Array.isArray(post.content.media) && post.content.media.length > 0;
  const hasMediaAttachment = Array.isArray(post.content.attachments)
    && post.content.attachments.some((a) => a.type === 'media');
  return isMediaType || hasMediaArray || hasMediaAttachment;
}

describe('media feed descriptor', () => {
  it('recognizes "media" as a valid feed descriptor', () => {
    expect(isValidFeedDescriptor('media')).toBe(true);
  });

  it('parses the "media" descriptor with no params', () => {
    const parsed = parseFeedDescriptor('media');
    expect(parsed.source).toBe('media');
    expect(parsed.params).toEqual([]);
  });
});

describe('FeedQueryBuilder.buildMediaFeedQuery', () => {
  it('matches media posts by type, content.media, or a media attachment', () => {
    const query = FeedQueryBuilder.buildMediaFeedQuery([], undefined);

    expect(query.visibility).toBe(PostVisibility.PUBLIC);
    expect(query.status).toBe('published');

    const and = query.$and as Array<Record<string, unknown>>;
    expect(Array.isArray(and)).toBe(true);

    const mediaClause = and.find((c) => Array.isArray(c.$or)
      && (c.$or as Array<Record<string, unknown>>).some((o) => 'content.media.0' in o));
    expect(mediaClause).toBeDefined();

    const orConditions = (mediaClause?.$or ?? []) as Array<Record<string, unknown>>;
    expect(orConditions).toContainEqual({ type: { $in: [PostType.IMAGE, PostType.VIDEO] } });
    expect(orConditions).toContainEqual({ 'content.media.0': { $exists: true } });
    expect(orConditions).toContainEqual({ 'content.attachments': { $elemMatch: { type: 'media' } } });
  });

  it('excludes boosts and seen posts, and applies a cursor', () => {
    const cursor = '65fdc8c8c8c8c8c8c8c8c8c8';
    const seen = ['65aaaaaaaaaaaaaaaaaaaaaa'];
    const query = FeedQueryBuilder.buildMediaFeedQuery(seen, cursor);
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

describe('media feed candidate selection', () => {
  const imagePost: SamplePost = {
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'a photo', media: [{ id: 'm1', type: 'image' }] },
  };

  const videoPost: SamplePost = {
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'a clip', media: [{ id: 'm2', type: 'video' }] },
  };

  const federatedMedia: SamplePost = {
    // Federated posts often arrive typed as TEXT but carry media in
    // content.media — they must still be included.
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'remote photo', media: [{ id: 'm3', type: 'image' }] },
    federation: { activityId: 'https://remote.example/users/alice/statuses/1' },
  };

  const attachmentMedia: SamplePost = {
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'with attachment', attachments: [{ type: 'media', mediaType: 'image' }] },
  };

  const textOnly: SamplePost = {
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'just text' },
  };

  const boostedMedia: SamplePost = {
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { text: 'boosted', media: [{ id: 'm4', type: 'image' }] },
    boostOf: '65bbbbbbbbbbbbbbbbbbbbbb',
  };

  it('includes an image post', () => {
    expect(matchesMediaFeed(imagePost)).toBe(true);
  });

  it('includes a video post', () => {
    expect(matchesMediaFeed(videoPost)).toBe(true);
  });

  it('includes a federated-shaped media post (no federation exclusion)', () => {
    expect(matchesMediaFeed(federatedMedia)).toBe(true);
  });

  it('includes a post with a media attachment', () => {
    expect(matchesMediaFeed(attachmentMedia)).toBe(true);
  });

  it('excludes a text-only post', () => {
    expect(matchesMediaFeed(textOnly)).toBe(false);
  });

  it('excludes a boost even when it carries media', () => {
    expect(matchesMediaFeed(boostedMedia)).toBe(false);
  });
});
