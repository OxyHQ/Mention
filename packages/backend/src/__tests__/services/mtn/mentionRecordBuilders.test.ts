import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock the service-scoped Oxy client so `resolvePostMediaEmbed`'s
// `getServiceAssetMetadataByIds` (fileId → sha256) is fully controllable and
// performs no real I/O. Hoisted so it predates the module-under-test import.
const oxyMock = vi.hoisted(() => ({
  getServiceAssetMetadataByIds: vi.fn<(ids: string[]) => Promise<Array<{ id: string; sha256: string; mime: string; size: number; status: 'active' | 'trash' }>>>(),
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => oxyMock,
}));

import {
  buildPostRecord,
  buildLikeRecord,
  buildRepostRecord,
  buildTombstoneRecord,
  buildBookmarkRecord,
  resolvePostMediaEmbed,
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

beforeEach(() => {
  oxyMock.getServiceAssetMetadataByIds.mockReset();
});

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

describe('resolvePostMediaEmbed', () => {
  it('resolves fileId media into a content-addressed blob embed (sha256/mime/size + alt)', async () => {
    oxyMock.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'file-img', sha256: 'sha-img', mime: 'image/png', size: 1234, status: 'active' },
      { id: 'file-vid', sha256: 'sha-vid', mime: 'video/mp4', size: 99999, status: 'active' },
    ]);
    const post = makePost({
      content: {
        text: 'with media',
        media: [
          { id: 'file-img', type: 'image', alt: 'a cat' },
          { id: 'file-vid', type: 'video' },
        ],
      },
    });

    const embed = await resolvePostMediaEmbed(post);

    // Exactly one batched lookup over both file ids, preserving order.
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledTimes(1);
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledWith(['file-img', 'file-vid']);
    expect(embed).toEqual({
      type: 'media',
      items: [
        { blob: { sha256: 'sha-img', mediaType: 'image', mime: 'image/png', size: 1234 }, alt: 'a cat' },
        { blob: { sha256: 'sha-vid', mediaType: 'video', mime: 'video/mp4', size: 99999 } },
      ],
    });

    // The resolved embed folds into a schema-valid post record carrying blob refs.
    const record = buildPostRecord(post, { embed });
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.embed).toEqual(embed);
  });

  it('FAIL-SOFT: a lookup error yields no embed (the record still emits without media)', async () => {
    // Simulate a `files:read`-scope 403 on the federation credential.
    oxyMock.getServiceAssetMetadataByIds.mockRejectedValue(new Error('403 forbidden: files:read'));
    const post = makePost({
      content: { text: 'media but no scope', media: [{ id: 'file-x', type: 'image' }] },
    });

    const embed = await resolvePostMediaEmbed(post);
    expect(embed).toBeUndefined();

    // buildPostRecord then emits a schema-valid record WITHOUT an embed.
    const record = buildPostRecord(post, { embed });
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.embed).toBeUndefined();
  });

  it('skips temp ids and absolute URLs, and unresolved sha256, never emitting a partial blob', async () => {
    oxyMock.getServiceAssetMetadataByIds.mockResolvedValue([
      // `file-ok` resolves; `file-trash` resolves with an empty sha256 → dropped.
      { id: 'file-ok', sha256: 'sha-ok', mime: 'image/jpeg', size: 10, status: 'active' },
      { id: 'file-trash', sha256: '', mime: 'image/jpeg', size: 0, status: 'trash' },
    ]);
    const post = makePost({
      content: {
        text: 'mixed',
        media: [
          { id: 'temp-pending', type: 'image' },
          { id: 'https://remote.example/img.png', type: 'image' },
          { id: 'file-ok', type: 'image' },
          { id: 'file-trash', type: 'image' },
        ],
      },
    });

    const embed = await resolvePostMediaEmbed(post);

    // Only the two bare Oxy file ids are looked up (temp/absolute filtered out).
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledWith(['file-ok', 'file-trash']);
    // Only the resolvable, non-empty-sha256 item survives.
    expect(embed).toEqual({
      type: 'media',
      items: [{ blob: { sha256: 'sha-ok', mediaType: 'image', mime: 'image/jpeg', size: 10 } }],
    });
  });

  it('returns undefined (no lookup) when the post has no media', async () => {
    const post = makePost({ content: { text: 'no media' } });
    const embed = await resolvePostMediaEmbed(post);
    expect(embed).toBeUndefined();
    expect(oxyMock.getServiceAssetMetadataByIds).not.toHaveBeenCalled();
  });
});
