import { describe, it, expect } from 'vitest';
import {
  buildPostRecord,
  buildLikeRecord,
  buildRepostRecord,
  buildTombstoneRecord,
  buildBookmarkRecord,
  type ReplyContext,
} from '../../../services/mtn/mentionRecordBuilders';
import type { IPost } from '../../../models/Post';
import {
  mentionPostRecordSchema,
  mentionLikeRecordSchema,
  mentionRepostRecordSchema,
  mentionTombstoneRecordSchema,
  mentionBookmarkRecordSchema,
} from '@mention/shared-types';

/**
 * Pure unit tests for the MTN record builders: each builder must produce a
 * payload that validates against its `app.mention.feed.*` lexicon schema, carry
 * only the lexicon-defined fields, and build correct MTN URIs.
 */

function makePost(overrides: Partial<IPost>): IPost {
  return {
    _id: 'post-1',
    oxyUserId: 'author-1',
    content: { text: 'hello' },
    createdAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  } as unknown as IPost;
}

describe('buildPostRecord', () => {
  it('builds a valid app.mention.feed.post payload for a top-level post', () => {
    const post = makePost({
      content: { text: 'hi there', sources: [{ url: 'https://example.com', title: 'Ex' }] },
      hashtags: ['news', 'tech'],
      language: 'en',
    });
    const record = buildPostRecord(post);

    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.text).toBe('hi there');
    expect(record.tags).toEqual(['news', 'tech']);
    expect(record.langs).toEqual(['en']);
    expect(record.sources).toEqual([{ url: 'https://example.com', title: 'Ex' }]);
    expect(record.reply).toBeUndefined();
    // B1: media embed is intentionally omitted (sha256 resolution is a B2 seam).
    expect(record.embed).toBeUndefined();
  });

  it('includes a reply ref with MTN URIs for a reply', () => {
    const post = makePost({ content: { text: 'a reply' } });
    const reply: ReplyContext = {
      root: { postId: 'root-1', oxyUserId: 'root-owner' },
      parent: { postId: 'parent-1', oxyUserId: 'parent-owner' },
    };
    const record = buildPostRecord(post, { reply });
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.reply).toEqual({
      root: 'mtn://root-owner/app.mention.feed.post/root-1',
      parent: 'mtn://parent-owner/app.mention.feed.post/parent-1',
    });
  });

  it('prefers the multi-language classification set when present', () => {
    const post = makePost({
      language: 'en',
      postClassification: { languages: ['es', 'en'] } as IPost['postClassification'],
    });
    const record = buildPostRecord(post);
    expect(record.langs).toEqual(['es', 'en']);
  });
});

describe('engagement builders', () => {
  it('buildLikeRecord builds a valid like payload with the liked post URI', () => {
    const record = buildLikeRecord({ likedPostId: 'p1', likedPostOwnerOxyUserId: 'owner-1' });
    expect(mentionLikeRecordSchema.safeParse(record).success).toBe(true);
    expect(record.subject).toBe('mtn://owner-1/app.mention.feed.post/p1');
  });

  it('buildRepostRecord builds a valid repost payload with the reposted post URI', () => {
    const record = buildRepostRecord({ repostedPostId: 'p2', repostedPostOwnerOxyUserId: 'owner-2' });
    expect(mentionRepostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.subject).toBe('mtn://owner-2/app.mention.feed.post/p2');
  });

  it('buildBookmarkRecord builds a valid bookmark payload', () => {
    const record = buildBookmarkRecord({ bookmarkedPostId: 'p3', bookmarkedPostOwnerOxyUserId: 'owner-3' });
    expect(mentionBookmarkRecordSchema.safeParse(record).success).toBe(true);
    expect(record.subject).toBe('mtn://owner-3/app.mention.feed.post/p3');
  });

  it('buildTombstoneRecord builds a valid tombstone payload', () => {
    const record = buildTombstoneRecord({ subjectUri: 'mtn://author-1/app.mention.feed.like/like-1' });
    expect(mentionTombstoneRecordSchema.safeParse(record).success).toBe(true);
    expect(record.subject).toBe('mtn://author-1/app.mention.feed.like/like-1');
  });
});
