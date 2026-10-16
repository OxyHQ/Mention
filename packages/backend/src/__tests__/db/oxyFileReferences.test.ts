/**
 * Oxy file references follow Mention's data in the writing transaction
 * (migration 0075's triggers) and the entity registry answers "is this pair in
 * use" the way the triggers mark it (`db/oxyFiles/fileReferenceEntities.ts`).
 *
 * Every way a file id enters or leaves a watched column is driven against real
 * rows: a post's media and a variant's override, an edit's delete-and-reinsert,
 * a post deleted by cascade, the GIF library, a banner, a poster pair. The
 * failure this guards is silent — a use Oxy never hears about is an application
 * file collected under a live post; a removal never sent keeps a file forever.
 *
 * The test database is shared: every assertion reads rows of ids this file made.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility, type MediaItem } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  deletePostRecord,
  insertPostRecord,
  replacePostContent,
} from '../../db/posts/postRepository';
import { gifs } from '../../db/schema/discovery';
import { federatedMediaPosters } from '../../db/schema/federation';
import {
  gifCacheFileRetirements,
  oxyFileReferenceSync,
  oxyFileStates,
} from '../../db/schema/oxyFiles';
import { postMedia, postVariantMedia } from '../../db/schema/postContent';
import { userSettings } from '../../db/schema/userProfile';
import {
  FILE_REFERENCE_ENTITIES,
  fileReferenceEntity,
  filesInUseByFederatedMedia,
  oxyEntityTypeFor,
  pairKey,
  parseOxyEntityType,
  POST_REFERENCE_SHARDS,
  shardOf,
  shardSql,
} from '../../db/oxyFiles/fileReferenceEntities';

let db: Database;
const AUTHOR = 'oxy-file-ref-author';
const fid = (label: string) => `ofr-${label}-${randomUUID().slice(0, 8)}`;

async function post(media: MediaItem[], variantMedia?: MediaItem[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [
        {
          source: 'author',
          text: 'refs',
          tag: 'en',
          ...(variantMedia ? { media: variantMedia } : {}),
        },
      ],
      media,
    },
  });
  return record.id;
}

async function marks(fileIds: string[]) {
  return db
    .select({
      fileId: oxyFileReferenceSync.fileId,
      entityType: oxyFileReferenceSync.entityType,
      entityId: oxyFileReferenceSync.entityId,
      state: oxyFileReferenceSync.state,
      generation: oxyFileReferenceSync.generation,
    })
    .from(oxyFileReferenceSync)
    .where(inArray(oxyFileReferenceSync.fileId, fileIds));
}

/** Settle every mark of these files as if the drain had told Oxy `add`. */
async function settleAsAdded(fileIds: string[]) {
  await db
    .update(oxyFileReferenceSync)
    .set({ state: 'synced', syncedOp: 'add' })
    .where(inArray(oxyFileReferenceSync.fileId, fileIds));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the post triggers mark (file, post) pairs', () => {
  it('marks every Oxy file of a new post, shared and variant, and nothing else', async () => {
    const shared = fid('shared');
    const override = fid('override');
    const id = await post(
      [
        { id: shared, type: 'image' },
        { id: 'https://remote.example/a.jpg', type: 'image' },
        { id: 'temp-123', type: 'image' },
      ],
      [{ id: override, type: 'image' }],
    );
    const rows = await marks([shared, override, 'https://remote.example/a.jpg', 'temp-123']);
    expect(rows.map((row) => [row.fileId, row.entityType, row.entityId, row.state]).sort()).toEqual(
      [
        [override, 'post', id, 'pending'],
        [shared, 'post', id, 'pending'],
      ].sort(),
    );
    await deletePostRecord(id);
  });

  it('re-marks a settled pair on an edit, and marks a dropped file for removal', async () => {
    const kept = fid('kept');
    const dropped = fid('dropped');
    const added = fid('added');
    const id = await post([
      { id: kept, type: 'image' },
      { id: dropped, type: 'image' },
    ]);
    await settleAsAdded([kept, dropped]);

    await replacePostContent(
      id,
      {
        variants: [{ source: 'author', text: 'edited', tag: 'en' }],
        media: [
          { id: kept, type: 'image' },
          { id: added, type: 'image' },
        ],
      },
      [],
    );

    const rows = await marks([kept, dropped, added]);
    expect(rows.every((row) => row.state === 'pending')).toBe(true);
    expect(rows.map((row) => row.fileId).sort()).toEqual([added, dropped, kept].sort());
    // In use or not is the drain's question; the registry answers it.
    const used = await fileReferenceEntity('post').pairsInUse(
      db,
      rows.map((row) => ({ fileId: row.fileId, entityId: row.entityId })),
    );
    expect([...used].sort()).toEqual([pairKey(added, id), pairKey(kept, id)].sort());
    await deletePostRecord(id);
  });

  it('marks a deleted post’s files, including a variant override deleted by cascade', async () => {
    const shared = fid('cascade-shared');
    const override = fid('cascade-override');
    const id = await post([{ id: shared, type: 'image' }], [{ id: override, type: 'image' }]);
    await settleAsAdded([shared, override]);

    await deletePostRecord(id);

    const rows = await marks([shared, override]);
    expect(rows.map((row) => [row.fileId, row.entityId, row.state]).sort()).toEqual(
      [
        [override, id, 'pending'],
        [shared, id, 'pending'],
      ].sort(),
    );
    const used = await fileReferenceEntity('post').pairsInUse(db, [
      { fileId: shared, entityId: id },
      { fileId: override, entityId: id },
    ]);
    expect(used.size).toBe(0);
  });

  it('keeps a pending row’s backoff but bumps its generation on every mark', async () => {
    const file = fid('gen');
    const id = await post([{ id: file, type: 'image' }]);
    await db
      .update(oxyFileReferenceSync)
      .set({ nextAttemptAt: sql`now() + interval '1 hour'`, attempts: 3 })
      .where(eq(oxyFileReferenceSync.fileId, file));
    const [before] = await marks([file]);

    await db.execute(sql`select mention_mark_file_reference(${file}, 'post', ${id})`);

    const [after] = await db
      .select({
        generation: oxyFileReferenceSync.generation,
        attempts: oxyFileReferenceSync.attempts,
        due: sql<boolean>`${oxyFileReferenceSync.nextAttemptAt} > now()`,
      })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect(after.generation).toBe(before.generation + 1);
    expect(after.attempts).toBe(3);
    expect(after.due).toBe(true);
    await deletePostRecord(id);
  });
});

describe('the other watched columns', () => {
  it('a GIF row marks both of its files under `gif`, and its deletion marks them again', async () => {
    const mp4 = fid('gif-mp4');
    const preview = fid('gif-preview');
    const [gif] = await db
      .insert(gifs)
      .values({
        klipyId: fid('klipy'),
        width: 10,
        height: 10,
        mp4FileId: mp4,
        previewFileId: preview,
        storage: 'application',
      })
      .returning({ id: gifs.id });
    expect((await marks([mp4, preview])).map((row) => [row.entityType, row.entityId])).toEqual([
      ['gif', gif.id],
      ['gif', gif.id],
    ]);
    const entity = fileReferenceEntity('gif');
    expect((await entity.pairsInUse(db, [{ fileId: mp4, entityId: gif.id }])).size).toBe(1);
    expect(await entity.filesInUse(db, [mp4, preview, fid('none')])).toEqual(
      new Set([mp4, preview]),
    );

    await settleAsAdded([mp4, preview]);
    await db.delete(gifs).where(eq(gifs.id, gif.id));
    expect((await marks([mp4, preview])).every((row) => row.state === 'pending')).toBe(true);
    expect((await entity.pairsInUse(db, [{ fileId: mp4, entityId: gif.id }])).size).toBe(0);
  });

  it('a banner is marked under the account, old and new on a change', async () => {
    const user = fid('user');
    const first = fid('banner1');
    const second = fid('banner2');
    await db.insert(userSettings).values({ oxyUserId: user, profileHeaderImage: first });
    await db
      .update(userSettings)
      .set({ profileHeaderImage: second })
      .where(eq(userSettings.oxyUserId, user));

    const rows = await marks([first, second]);
    expect(rows.map((row) => [row.fileId, row.entityType, row.entityId]).sort()).toEqual(
      [
        [first, 'profile_banner', user],
        [second, 'profile_banner', user],
      ].sort(),
    );
    const used = await fileReferenceEntity('profile_banner').pairsInUse(db, [
      { fileId: first, entityId: user },
      { fileId: second, entityId: user },
    ]);
    expect([...used]).toEqual([pairKey(second, user)]);
    expect(await filesInUseByFederatedMedia(db, [first, second])).toEqual(new Set([second]));
    await db.delete(userSettings).where(eq(userSettings.oxyUserId, user));
  });

  it('a poster is in use exactly while a post shows its video', async () => {
    const video = fid('video');
    const poster = fid('poster');
    await db.insert(federatedMediaPosters).values({ videoFileId: video, posterFileId: poster });
    expect((await marks([poster])).map((row) => [row.entityType, row.entityId])).toEqual([
      ['video_poster', video],
    ]);
    const entity = fileReferenceEntity('video_poster');
    const pair = [{ fileId: poster, entityId: video }];
    expect((await entity.pairsInUse(db, pair)).size).toBe(0);

    const id = await post([{ id: video, type: 'video' }]);
    expect((await entity.pairsInUse(db, pair)).size).toBe(1);
    expect(await entity.filesInUse(db, [poster])).toEqual(new Set([poster]));
    expect(await filesInUseByFederatedMedia(db, [poster, video])).toEqual(new Set([poster, video]));

    await deletePostRecord(id);
    expect((await entity.pairsInUse(db, pair)).size).toBe(0);
    await db.delete(federatedMediaPosters).where(eq(federatedMediaPosters.posterFileId, poster));
  });

  it('a job application nobody made uses nothing', async () => {
    const used = await fileReferenceEntity('job_application').pairsInUse(db, [
      { fileId: fid('resume'), entityId: fid('application') },
    ]);
    expect(used.size).toBe(0);
  });
});

describe('the inventory is what the triggers mark, shard by shard', () => {
  it("lists a post's files in exactly the post's shard", async () => {
    const shared = fid('inv-shared');
    const override = fid('inv-override');
    const id = await post([{ id: shared, type: 'image' }], [{ id: override, type: 'image' }]);
    const entity = fileReferenceEntity('post');
    const shard = shardOf(id, POST_REFERENCE_SHARDS);

    const inShard = await entity.inventory(db, shard);
    expect(inShard).toContainEqual({ fileId: shared, entityId: id });
    expect(inShard).toContainEqual({ fileId: override, entityId: id });
    const other = await entity.inventory(db, (shard + 1) % POST_REFERENCE_SHARDS);
    expect(other.some((pair) => pair.entityId === id)).toBe(false);
    await deletePostRecord(id);
  });
});

describe('Oxy entity type names', () => {
  it('computes the same shard in TypeScript and in SQL', async () => {
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const rows = await db.execute<{ id: string; shard: number }>(sql`
      select t.id, ${shardSql(sql`t.id`, POST_REFERENCE_SHARDS)} as shard
      from unnest(${sql.param(ids)}::text[]) as t(id)
    `);
    for (const row of rows) {
      expect(Number(row.shard)).toBe(shardOf(row.id, POST_REFERENCE_SHARDS));
    }
  });

  it('names a post by its shard and reads every name back', () => {
    const id = randomUUID();
    const name = oxyEntityTypeFor(fileReferenceEntity('post'), id);
    expect(name).toMatch(/^post\.\d{2}$/);
    expect(parseOxyEntityType(name)).toEqual({
      entity: fileReferenceEntity('post'),
      shard: shardOf(id, POST_REFERENCE_SHARDS),
    });
    for (const entity of FILE_REFERENCE_ENTITIES.filter((e) => e.shards === 1)) {
      expect(oxyEntityTypeFor(entity, id)).toBe(entity.type);
      expect(parseOxyEntityType(entity.type)?.entity).toBe(entity);
    }
    for (const bad of ['post', 'post.32', 'post.7', 'gif.00', 'nothing', 'post.01.x']) {
      expect(parseOxyEntityType(bad)).toBeNull();
    }
  });
});

describe('withholding and retired GIF files are applied on insert', () => {
  it('a new media row takes its file’s withholding from oxy_file_states', async () => {
    const file = fid('withheld');
    await db.insert(oxyFileStates).values({
      fileId: file,
      status: 'blocked',
      visibility: 'public',
      withheld: 'blocked',
      lastEventId: fid('evt'),
      lastEventAt: new Date(),
    });
    const id = await post([{ id: file, type: 'image' }], [{ id: file, type: 'image' }]);
    const [shared] = await db
      .select({ withheld: postMedia.withheld })
      .from(postMedia)
      .where(eq(postMedia.postId, id));
    const [override] = await db
      .select({ withheld: postVariantMedia.withheld })
      .from(postVariantMedia)
      .where(eq(postVariantMedia.mediaId, file));
    expect(shared.withheld).toBe('blocked');
    expect(override.withheld).toBe('blocked');
    await deletePostRecord(id);
    await db.delete(oxyFileStates).where(eq(oxyFileStates.fileId, file));
  });

  it('a retired GIF cache file id is stored as its replacement, alt text included', async () => {
    const oldId = fid('old-gif');
    const newId = fid('new-gif');
    await db.insert(gifCacheFileRetirements).values({ oldFileId: oldId, newFileId: newId });
    const record = await insertPostRecord({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      type: PostType.IMAGE,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: {
        variants: [{ source: 'author', text: 'gif', tag: 'en', alt: { [oldId]: 'a dancing cat' } }],
        media: [{ id: oldId, type: 'gif' }],
        attachments: [{ type: 'media', id: oldId, mediaType: 'gif' }],
      },
    });
    const rows = await db
      .select({ mediaId: postMedia.mediaId })
      .from(postMedia)
      .where(eq(postMedia.postId, record.id));
    expect(rows).toEqual([{ mediaId: newId }]);
    const alt = await db.execute<{ media_id: string }>(sql`
      select a.media_id from post_variant_alt_texts a
      join post_content_variants v on v.id = a.variant_id where v.post_id = ${record.id}
    `);
    expect([...alt].map((row) => row.media_id)).toEqual([newId]);
    const attachments = await db.execute<{ attachment_id: string }>(sql`
      select attachment_id from post_attachments where post_id = ${record.id} and type = 'media'
    `);
    expect([...attachments].map((row) => row.attachment_id)).toEqual([newId]);
    expect((await marks([oldId, newId])).map((row) => row.fileId)).toEqual([newId]);
    await deletePostRecord(record.id);
    await db
      .delete(gifCacheFileRetirements)
      .where(and(eq(gifCacheFileRetirements.oldFileId, oldId)));
  });
});
