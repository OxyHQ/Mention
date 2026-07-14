import { beforeEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// Mock the service-scoped Oxy client so `resolvePostRecordEmbeds`'s
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
  resolvePostRecordEmbeds,
  type ReplyContext,
} from '../../../services/mtn/mentionRecordBuilders';
import type { IPost } from '../../../models/Post';
import type { PostContentVariant, StoredPostContent } from '@mention/shared-types';
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

/** The post's body lives ONLY in `content.variants` — `variants[0]` is the primary. */
function body(text: string, tag?: string): StoredPostContent {
  const variant: PostContentVariant = { source: 'author', text };
  if (tag) variant.tag = tag;
  return { variants: [variant] };
}

function makePost(overrides: Partial<IPost>): IPost {
  return {
    _id: 'post-1',
    oxyUserId: 'author-1',
    content: body('hello'),
    createdAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  } as unknown as IPost;
}

describe('buildPostRecord', () => {
  it('builds a valid app.mention.feed.post payload for a top-level post', () => {
    const post = makePost({
      content: { ...body('hi there'), sources: [{ url: 'https://example.com', title: 'Ex' }] },
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
    const post = makePost({ content: body('a reply') });
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

describe('resolvePostRecordEmbeds', () => {
  it('resolves fileId media into a content-addressed blob embed (sha256/mime/size + alt)', async () => {
    oxyMock.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'file-img', sha256: 'sha-img', mime: 'image/png', size: 1234, status: 'active' },
      { id: 'file-vid', sha256: 'sha-vid', mime: 'video/mp4', size: 99999, status: 'active' },
    ]);
    const post = makePost({
      content: {
        ...body('with media'),
        media: [
          { id: 'file-img', type: 'image', alt: 'a cat' },
          { id: 'file-vid', type: 'video' },
        ],
      },
    });

    const embeds = await resolvePostRecordEmbeds(post);
    const embed = embeds.embed;

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
    const record = buildPostRecord(post, { embeds });
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.embed).toEqual(embed);
  });

  it('FAIL-SOFT: a lookup error yields no embed (the record still emits without media)', async () => {
    // Simulate a `files:read`-scope 403 on the federation credential.
    oxyMock.getServiceAssetMetadataByIds.mockRejectedValue(new Error('403 forbidden: files:read'));
    const post = makePost({
      content: { ...body('media but no scope'), media: [{ id: 'file-x', type: 'image' }] },
    });

    const embeds = await resolvePostRecordEmbeds(post);
    const embed = embeds.embed;
    expect(embed).toBeUndefined();

    // buildPostRecord then emits a schema-valid record WITHOUT an embed.
    const record = buildPostRecord(post, { embeds });
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
        ...body('mixed'),
        media: [
          { id: 'temp-pending', type: 'image' },
          { id: 'https://remote.example/img.png', type: 'image' },
          { id: 'file-ok', type: 'image' },
          { id: 'file-trash', type: 'image' },
        ],
      },
    });

    const embeds = await resolvePostRecordEmbeds(post);
    const embed = embeds.embed;

    // Only the two bare Oxy file ids are looked up (temp/absolute filtered out).
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledWith(['file-ok', 'file-trash']);
    // Only the resolvable, non-empty-sha256 item survives.
    expect(embed).toEqual({
      type: 'media',
      items: [{ blob: { sha256: 'sha-ok', mediaType: 'image', mime: 'image/jpeg', size: 10 } }],
    });
  });

  it('returns undefined (no lookup) when the post has no media', async () => {
    const post = makePost({ content: body('no media') });
    const embeds = await resolvePostRecordEmbeds(post);
    const embed = embeds.embed;
    expect(embed).toBeUndefined();
    expect(oxyMock.getServiceAssetMetadataByIds).not.toHaveBeenCalled();
  });
});

describe('buildPostRecord — multilingual variants on the chain', () => {
  it('signs the AUTHOR variants (primary first) and NEVER a machine translation', () => {
    const post = makePost({
      content: {
        variants: [
          { tag: 'es-ES', source: 'author', text: 'hola mundo' },
          { tag: 'en-US', source: 'author', text: 'hello world' },
          // A machine translation is DERIVED content: signing it onto the
          // author's chain would attribute to them words they never wrote.
          { tag: 'fr-FR', source: 'machine', text: 'bonjour le monde' },
        ],
      },
      language: 'es',
    });

    const record = buildPostRecord(post);

    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.text).toBe('hola mundo');
    expect(record.variants).toEqual([
      { tag: 'es-ES', text: 'hola mundo' },
      { tag: 'en-US', text: 'hello world' },
    ]);
  });

  it('re-keys a variant alt map from Oxy file id to blob sha256 — the chain has no file ids in it', async () => {
    oxyMock.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'file-img', sha256: 'sha-img', mime: 'image/png', size: 10, status: 'active' },
    ]);
    const post = makePost({
      content: {
        media: [{ id: 'file-img', type: 'image', alt: 'un gato' }],
        variants: [
          { tag: 'es', source: 'author', text: 'hola' },
          { tag: 'en', source: 'author', text: 'hi', alt: { 'file-img': 'a cat' } },
        ],
      },
    });

    const embeds = await resolvePostRecordEmbeds(post);
    const record = buildPostRecord(post, { embeds });

    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.variants?.[1]).toEqual({ tag: 'en', text: 'hi', alt: { 'sha-img': 'a cat' } });
  });

  it('resolves a variant media OVERRIDE to its own content-addressed embed, in ONE batched lookup', async () => {
    oxyMock.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'file-es', sha256: 'sha-es', mime: 'image/png', size: 10, status: 'active' },
      { id: 'file-en', sha256: 'sha-en', mime: 'image/png', size: 20, status: 'active' },
    ]);
    const post = makePost({
      content: {
        media: [{ id: 'file-es', type: 'image' }],
        variants: [
          { tag: 'es', source: 'author', text: 'infografía' },
          // A different infographic for the English reader: REPLACES the media set.
          { tag: 'en', source: 'author', text: 'infographic', media: [{ id: 'file-en', type: 'image' }] },
        ],
      },
    });

    const embeds = await resolvePostRecordEmbeds(post);
    const record = buildPostRecord(post, { embeds });

    // The shared set and every variant override resolve together — one call, not
    // one per language.
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledTimes(1);
    expect(oxyMock.getServiceAssetMetadataByIds).toHaveBeenCalledWith(['file-es', 'file-en']);
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
    expect(record.embed?.items[0].blob.sha256).toBe('sha-es');
    expect(record.variants?.[1].embed).toEqual({
      type: 'media',
      items: [{ blob: { sha256: 'sha-en', mediaType: 'image', mime: 'image/png', size: 20 } }],
    });
  });

  it('emits NO variants for a monolingual post — `text` already carries that body', () => {
    // A one-entry `variants` array would just be a second copy of `text` on the
    // wire, in every signed record of every monolingual post. The tag survives in
    // `langs`, so the materializer rebuilds the rendition exactly.
    const record = buildPostRecord(makePost({ content: body('hola', 'es-ES') }));

    expect(record.variants).toBeUndefined();
    expect(record.text).toBe('hola');
    expect(record.langs).toEqual(['es-ES']);
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
  });

  it('emits the author’s PRECISE tags in `langs`, not the classifier’s base codes', () => {
    // `langs` is BCP-47 by protocol. Emitting the classifier's `es` would lose the
    // region, and a post round-tripped through the chain would come back `es`.
    const record = buildPostRecord(makePost({
      content: {
        variants: [
          { tag: 'es-ES', source: 'author', text: 'hola' },
          { tag: 'pt-BR', source: 'author', text: 'ola' },
        ],
      },
      postClassification: { languages: ['es', 'pt'] } as IPost['postClassification'],
    }));

    expect(record.langs).toEqual(['es-ES', 'pt-BR']);
  });

  it('emits no variants and no langs for an UNTAGGED body', () => {
    // A body nobody could assign a language to. It is still the post — `text`
    // carries it — but there is no tag to key a lexicon variant by, and no
    // language to declare.
    const record = buildPostRecord(makePost({ content: body('+1') }));

    expect(record.text).toBe('+1');
    expect(record.variants).toBeUndefined();
    expect(record.langs).toBeUndefined();
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe('MTN chain compatibility — a reader on the OLD schema degrades to `text`', () => {
  /**
   * The `app.mention.feed.post` schema BEFORE `variants` existed. Records are
   * signed VERBATIM and the lexicon schema is a plain `z.object` (not `.strict()`),
   * so an older reader must STRIP the unknown key rather than reject the record —
   * that is what keeps a multilingual post's chain verifiable by everyone.
   */
  const legacyPostRecordSchema = z.object({
    text: z.string(),
    embed: z.unknown().optional(),
    reply: z.unknown().optional(),
    langs: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.string().min(1),
  });

  it('a record WITH variants still verifies, and an old reader degrades to the primary body', () => {
    const post = makePost({
      content: {
        variants: [
          { tag: 'es-ES', source: 'author', text: 'hola mundo' },
          { tag: 'en-US', source: 'author', text: 'hello world' },
        ],
      },
      language: 'es',
    });
    const record = buildPostRecord(post);

    // Current reader: the full multilingual record validates.
    expect(mentionPostRecordSchema.safeParse(record).success).toBe(true);

    // Old reader: the unknown `variants` key is STRIPPED, not rejected...
    const legacy = legacyPostRecordSchema.safeParse(record);
    expect(legacy.success).toBe(true);
    if (!legacy.success) throw new Error('legacy reader must not reject a multilingual record');
    expect(legacy.data).not.toHaveProperty('variants');
    // ...and what survives is a complete, correct post in the author's primary language.
    expect(legacy.data.text).toBe('hola mundo');
    expect(legacy.data.langs).toEqual(['es-ES', 'en-US']);
  });
});
