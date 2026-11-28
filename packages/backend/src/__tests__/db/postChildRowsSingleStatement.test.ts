/**
 * `readPostChildTables` reads a post's ten child tables in ONE statement. This
 * suite proves it returns exactly what the ten per-table reads it replaced
 * returned — same rows, same values, same types, same order — on real rows.
 *
 * The reference below is the replaced code, verbatim. Rows are compared grouped
 * by their owner (post or variant), which is the only shape anything consumes
 * (`loadChildRows` groups them straight away): every sort key is unique within
 * an owner (`*_post_id_position_key`, `post_mentions` by id,
 * `post_recipients_pkey`, `post_classification_topic_refs_post_id_name_key`,
 * `post_variant_alt_texts_variant_id_media_id_key`), so the order inside a group
 * is fully determined, while the order ACROSS owners of a tied key (two posts'
 * `position` 0) never was.
 *
 * The fixtures exercise every column type the tables use: microsecond
 * timestamps (a `Date` keeps milliseconds either way), doubles whose shortest
 * form needs all 17 digits, zero, NULL in every nullable column, booleans of both
 * values, non-ASCII and quote-bearing text, and a multi-post batch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  closePostgres,
  connectPostgres,
  getDb,
  type DatabaseOrTransaction,
} from '../../db/postgres';
import {
  loadPostRecords,
  readPostChildTables,
  variantReadColumns,
} from '../../db/posts/postRepository';
import {
  postAttachments,
  postAuthorships,
  postClassificationTopicRefs,
  postContentVariants,
  postMedia,
  postMentions,
  postRecipients,
  postSources,
  postVariantAltTexts,
  postVariantMedia,
} from '../../db/schema/postContent';
import { clearPostScope, postScope, seedPosts } from '../helpers/postFixtures';

const scope = postScope('child-rows-single-statement');

/** The per-table reads `readPostChildTables` replaced, verbatim. */
async function perTableReference(db: DatabaseOrTransaction, postIds: readonly string[]) {
  const variantIdsOfPosts = db
    .select({ id: postContentVariants.id })
    .from(postContentVariants)
    .where(inArray(postContentVariants.postId, [...postIds]));
  const [
    authorships,
    variants,
    media,
    attachments,
    sources,
    mentions,
    recipients,
    topicRefs,
    variantMedia,
    variantAltTexts,
  ] = await Promise.all([
    db
      .select()
      .from(postAuthorships)
      .where(inArray(postAuthorships.postId, [...postIds]))
      .orderBy(
        sql`case ${postAuthorships.role} when 'owner' then 0 else 1 end`,
        asc(postAuthorships.id),
      ),
    db
      .select(variantReadColumns)
      .from(postContentVariants)
      .where(inArray(postContentVariants.postId, [...postIds]))
      .orderBy(asc(postContentVariants.position)),
    db
      .select()
      .from(postMedia)
      .where(inArray(postMedia.postId, [...postIds]))
      .orderBy(asc(postMedia.position)),
    db
      .select()
      .from(postAttachments)
      .where(inArray(postAttachments.postId, [...postIds]))
      .orderBy(asc(postAttachments.position)),
    db
      .select()
      .from(postSources)
      .where(inArray(postSources.postId, [...postIds]))
      .orderBy(asc(postSources.position)),
    db
      .select()
      .from(postMentions)
      .where(inArray(postMentions.postId, [...postIds]))
      .orderBy(asc(postMentions.id)),
    db
      .select()
      .from(postRecipients)
      .where(inArray(postRecipients.postId, [...postIds]))
      .orderBy(asc(postRecipients.oxyUserId)),
    db
      .select()
      .from(postClassificationTopicRefs)
      .where(inArray(postClassificationTopicRefs.postId, [...postIds]))
      .orderBy(
        sql`${postClassificationTopicRefs.relevance} desc nulls last`,
        asc(postClassificationTopicRefs.name),
      ),
    db
      .select()
      .from(postVariantMedia)
      .where(inArray(postVariantMedia.variantId, variantIdsOfPosts))
      .orderBy(asc(postVariantMedia.position)),
    db
      .select()
      .from(postVariantAltTexts)
      .where(inArray(postVariantAltTexts.variantId, variantIdsOfPosts))
      .orderBy(asc(postVariantAltTexts.mediaId)),
  ]);
  return {
    authorships,
    variants,
    media,
    attachments,
    sources,
    mentions,
    recipients,
    topicRefs,
    variantMedia,
    variantAltTexts,
  };
}

type Tables = Awaited<ReturnType<typeof perTableReference>>;

/** Each table's rows grouped by owner, owners in a fixed order, rows in read order. */
function grouped(tables: Tables): Record<string, Record<string, unknown[]>> {
  const out: Record<string, Record<string, unknown[]>> = {};
  for (const [name, rows] of Object.entries(tables) as [string, Record<string, unknown>[]][]) {
    const byOwner = new Map<string, unknown[]>();
    for (const row of rows) {
      const owner = String(row.postId ?? row.variantId);
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), row]);
    }
    out[name] = Object.fromEntries([...byOwner].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return out;
}

/** Microsecond-precision instants, so the JSON form's extra digits are exercised. */
const MICROS_A = sql`'2026-11-28 10:11:12.345678+00'::timestamptz`;
const MICROS_B = sql`'2025-02-03 04:05:06.999999+00'::timestamptz`;

async function seedRichPost(postId: string, variantId: string, salt: string): Promise<void> {
  const db = getDb();
  await db.insert(postAuthorships).values([
    {
      postId,
      oxyUserId: scope.user(`collab-${salt}-1`),
      role: 'collaborator',
      status: 'pending',
      invitedAt: MICROS_A as never,
    },
    {
      postId,
      oxyUserId: scope.user(`collab-${salt}-2`),
      role: 'collaborator',
      status: 'accepted',
      invitedAt: MICROS_B as never,
      respondedAt: MICROS_A as never,
    },
  ]);
  const [second] = await db
    .insert(postContentVariants)
    .values({
      postId,
      position: 1,
      tag: 'es',
      source: 'machine',
      body: `«Hola» "quoted" 'single' \\ back\\slash ${salt} — ñ 你好 🎉`,
      articleTitle: `Título ${salt}`,
      articleBody: 'line one\nline two\ttabbed',
      articleExcerpt: null,
      variantCreatedAt: MICROS_B as never,
    })
    .returning({ id: postContentVariants.id });
  await db.insert(postMedia).values([
    {
      postId,
      position: 0,
      mediaId: `media-${salt}-0`,
      type: 'video',
      alt: 'a "video" — ñ',
      width: 1920,
      height: 1080,
      durationSec: 12.345678901234567,
      sizeBytes: 1,
      orientation: 'landscape',
      aspectRatio: 1.7777777777777777,
      mime: 'video/mp4',
      hlsReadyAt: MICROS_A as never,
      remoteUrl: 'https://remote.example/v.mp4?a=1&b=2',
      cachedFromFederation: true,
      withheld: null,
    },
    {
      postId,
      position: 1,
      mediaId: `media-${salt}-1`,
      type: 'image',
      alt: null,
      width: null,
      height: null,
      durationSec: 1e-7,
      sizeBytes: null,
      orientation: null,
      aspectRatio: 0.1,
      mime: null,
      hlsReadyAt: null,
      remoteUrl: null,
      cachedFromFederation: false,
      withheld: 'blocked',
    },
  ]);
  await db.insert(postAttachments).values([
    { postId, position: 0, type: 'media', attachmentId: `media-${salt}-0`, mediaType: 'video' },
    { postId, position: 1, type: 'poll', attachmentId: `poll-${salt}`, mediaType: null },
  ]);
  await db.insert(postSources).values([
    { postId, position: 0, url: 'https://source.example/a', title: 'Fuente «uno»' },
    { postId, position: 1, url: 'https://source.example/b', title: null },
  ]);
  await db.insert(postMentions).values([
    { postId, oxyUserId: scope.user(`mentioned-${salt}-b`) },
    { postId, oxyUserId: scope.user(`mentioned-${salt}-a`) },
  ]);
  await db.insert(postRecipients).values([
    { postId, oxyUserId: scope.user(`recipient-${salt}-z`) },
    { postId, oxyUserId: scope.user(`recipient-${salt}-a`) },
  ]);
  await db.insert(postClassificationTopicRefs).values([
    { postId, name: `Zeta ${salt}`, topicId: null, relevance: null, type: null },
    { postId, name: `Alpha ${salt}`, topicId: 'topic-1', relevance: 3, type: 'topic' },
    { postId, name: `Beta ${salt}`, topicId: 'topic-2', relevance: 3, type: 'entity' },
    { postId, name: `Gamma ${salt}`, topicId: null, relevance: 9, type: 'topic' },
  ]);
  for (const owner of [variantId, second.id]) {
    await db.insert(postVariantMedia).values([
      {
        variantId: owner,
        position: 1,
        mediaId: `vmedia-${salt}-1`,
        type: 'gif',
        alt: 'gif',
        width: 10,
        height: 20,
        durationSec: 2.5,
        sizeBytes: 123,
        orientation: 'portrait',
        aspectRatio: 0.5,
        mime: 'image/gif',
        hlsReadyAt: null,
        remoteUrl: null,
        cachedFromFederation: null,
        withheld: null,
      },
      {
        variantId: owner,
        position: 0,
        mediaId: `vmedia-${salt}-0`,
        type: 'image',
        alt: null,
        width: null,
        height: null,
        durationSec: null,
        sizeBytes: null,
        orientation: 'square',
        aspectRatio: null,
        mime: null,
        hlsReadyAt: MICROS_B as never,
        remoteUrl: null,
        cachedFromFederation: false,
        withheld: 'private',
      },
    ]);
    await db.insert(postVariantAltTexts).values([
      { variantId: owner, mediaId: `media-${salt}-1`, description: 'Second — «alt»' },
      { variantId: owner, mediaId: `media-${salt}-0`, description: 'First "alt" \\ ñ' },
    ]);
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

async function seedBatch(): Promise<string[]> {
  const seeded = await seedPosts(scope, [{}, {}, {}]);
  const [rich, richer] = seeded;
  for (const [index, post] of [rich, richer].entries()) {
    const [variant] = await getDb()
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, post.id));
    await seedRichPost(post.id, variant.id, `p${index}`);
  }
  // The third post keeps only what `seedPosts` gives every post: an owner and one variant.
  return seeded.map((post) => post.id);
}

describe('readPostChildTables', () => {
  it('returns exactly what the per-table reads returned, for one post', async () => {
    const [postId] = await seedBatch();
    const db = getDb();

    const expected = await perTableReference(db, [postId]);
    const actual = await readPostChildTables(db, [postId]);

    expect(grouped(actual)).toEqual(grouped(expected));
    // The order the consumer sees inside a post, asserted outright as well.
    expect(actual.media.map((row) => row.position)).toEqual([0, 1]);
    expect(actual.authorships[0]?.role).toBe('owner');
    expect(actual.topicRefs.map((row) => row.relevance)).toEqual([9, 3, 3, null]);
    expect(actual.media[0]?.hlsReadyAt).toBeInstanceOf(Date);
    expect(actual.media[0]?.aspectRatio).toBe(1.7777777777777777);
  });

  it('returns exactly what the per-table reads returned, for a batch', async () => {
    const ids = await seedBatch();
    const db = getDb();
    const asked = [...ids, '019616a0-0000-7000-8000-00000000cafe'];

    const expected = await perTableReference(db, asked);
    const actual = await readPostChildTables(db, asked);

    expect(grouped(actual)).toEqual(grouped(expected));
    for (const name of Object.keys(expected) as (keyof Tables)[]) {
      expect(actual[name]).toHaveLength(expected[name].length);
    }
  });

  it('returns empty tables for posts that have no rows', async () => {
    const db = getDb();
    const actual = await readPostChildTables(db, ['019616a0-0000-7000-8000-00000000beef']);

    for (const rows of Object.values(actual)) expect(rows).toEqual([]);
  });

  it('works inside a transaction, as assembly after a write does', async () => {
    const [postId] = await seedBatch();
    const expected = await perTableReference(getDb(), [postId]);

    const actual = await getDb().transaction((tx) => readPostChildTables(tx, [postId]));

    expect(grouped(actual)).toEqual(grouped(expected));
  });

  it('assembles the same records it did', async () => {
    const ids = await seedBatch();
    const records = await loadPostRecords(ids);

    expect(records.map((record) => record.id)).toEqual(ids);
    const rich = records[0];
    expect(rich.content.variants.map((variant) => variant.tag)).toEqual(['en', 'es']);
    expect(rich.content.media?.map((item) => item.id)).toEqual(['media-p0-0', 'media-p0-1']);
    expect(rich.authorship?.[0]?.role).toBe('owner');
    expect(rich.authorship).toHaveLength(3);
    expect(rich.content.sources?.map((source) => source.url)).toEqual([
      'https://source.example/a',
      'https://source.example/b',
    ]);
  });
});
