/**
 * The constraints that carry a rule Mongo could not state, asserted by trying
 * to violate them against real rows.
 *
 * Each case here corresponds to something that was previously enforced by
 * application code, by a Mongoose validator that updates bypassed, or by
 * nothing at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { isUniqueViolation } from '../../db/pgErrors';
import { uuidv7 } from '../../db/schema/columns';
import { posts } from '../../db/schema/posts';
import { postAuthorships, postContentVariants } from '../../db/schema/postContent';
import { likes } from '../../db/schema/engagement';
import { threadgateAllowRules, threadgates } from '../../db/schema/gates';
import { userSettings } from '../../db/schema/userProfile';

let db: Database;
const createdPostIds: string[] = [];

async function createPost(): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({ oxyUserId: 'oxy-constraints-author' })
    .returning({ id: posts.id });
  createdPostIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (createdPostIds.length > 0) {
    const id = createdPostIds.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('uuid v7 ids', () => {
  it('produces a well-formed version-7 uuid', () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('sorts lexicographically by creation time', async () => {
    const first = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = uuidv7();
    // This is the whole reason v7 was chosen over v4: an append-mostly primary
    // key index instead of inserts scattered across the keyspace.
    expect(first < second).toBe(true);
  });

  it('accepts a 24-char ObjectId hex verbatim as a primary key', async () => {
    // The migration preserves ids, so both formats must coexist in one column.
    // A backfilled row's id is the raw Mongo `_id` — it appears in published
    // ActivityPub URIs and inside signed MTN records, so it cannot be remapped.
    const objectIdHex = '6a2f9d8989b795cfdfac350f';
    await db.insert(posts).values({ id: objectIdHex, oxyUserId: 'oxy-constraints-author' });
    createdPostIds.push(objectIdHex);

    const rows = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, objectIdHex));
    expect(rows[0]?.id).toBe(objectIdHex);
  });
});

describe('posts.status', () => {
  it('accepts `restricted`, which the Mongoose enum forbids', async () => {
    // `models/Post.ts` declares three values; `ModerationEnforcementService`
    // writes a fourth through `updateOne`, which runs no validators. Porting the
    // Mongoose enum verbatim would start rejecting rows Mongo has been storing.
    const [row] = await db
      .insert(posts)
      .values({ oxyUserId: 'oxy-constraints-author', status: 'restricted' })
      .returning({ id: posts.id, status: posts.status });
    createdPostIds.push(row.id);
    expect(row.status).toBe('restricted');
  });

  it('rejects a value outside the closed set', async () => {
    await expect(
      db.execute(sql`
        insert into posts (id, status) values (${uuidv7()}, 'shadowbanned')
      `)
    ).rejects.toThrow();
  });
});

describe('posts.reply_permission', () => {
  it('rejects an element outside the closed set', async () => {
    // A scalar enum column cannot express this: the constraint is on the array's
    // ELEMENTS, and Mongo's array-enum was never enforced on an update.
    await expect(
      db.execute(sql`
        insert into posts (id, reply_permission)
        values (${uuidv7()}, array['anyone', 'nobody', 'maybe']::text[])
      `)
    ).rejects.toThrow();
  });

  it('accepts a legal subset', async () => {
    const [row] = await db
      .insert(posts)
      .values({
        oxyUserId: 'oxy-constraints-author',
        replyPermission: ['followers', 'mentioned'],
      })
      .returning({ id: posts.id, replyPermission: posts.replyPermission });
    createdPostIds.push(row.id);
    expect(row.replyPermission).toEqual(['followers', 'mentioned']);
  });
});

describe('post_authorships', () => {
  it('allows exactly one owner per post', async () => {
    const postId = await createPost();
    await db.insert(postAuthorships).values({
      postId,
      oxyUserId: 'owner-a',
      role: 'owner',
      status: 'accepted',
    });

    let caught: unknown;
    try {
      await db.insert(postAuthorships).values({
        postId,
        oxyUserId: 'owner-b',
        role: 'owner',
        status: 'accepted',
      });
    } catch (error) {
      caught = error;
    }
    // `getOwnerId` assumes there is one owner. Mongo could hold two.
    expect(isUniqueViolation(caught, 'post_authorships_one_owner_per_post')).toBe(true);
  });

  it('allows many collaborators alongside that owner', async () => {
    const postId = await createPost();
    await db.insert(postAuthorships).values([
      { postId, oxyUserId: 'owner-a', role: 'owner', status: 'accepted' },
      { postId, oxyUserId: 'collab-a', role: 'collaborator', status: 'pending' },
      { postId, oxyUserId: 'collab-b', role: 'collaborator', status: 'accepted' },
    ]);
    const rows = await db
      .select({ id: postAuthorships.id })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, postId));
    expect(rows).toHaveLength(3);
  });
});

describe('post_content_variants', () => {
  it('allows at most one rendition per language, and any number untagged', async () => {
    const postId = await createPost();
    await db.insert(postContentVariants).values([
      { postId, position: 0, source: 'author', body: 'hola', tag: 'es' },
      { postId, position: 1, source: 'machine', body: 'hello', tag: 'en' },
    ]);

    let caught: unknown;
    try {
      await db
        .insert(postContentVariants)
        .values({ postId, position: 2, source: 'machine', body: 'hola otra vez', tag: 'es' });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'post_content_variants_post_id_tag_key')).toBe(true);
  });

  it('generates a search vector from the body', async () => {
    const postId = await createPost();
    await db.insert(postContentVariants).values({
      postId,
      position: 0,
      source: 'author',
      body: 'migrating databases carefully',
    });

    // The port of Mongo's text index. A `LIKE '%…%'` scan would pass a
    // "does it find the row" test while being a table scan wearing one's
    // clothes, so the assertion is that the STEMMED query matches.
    const rows = await db.execute<{ id: string }>(sql`
      select v.id from post_content_variants v
      where v.post_id = ${postId}
        and v.search_vector @@ to_tsquery('english', 'migrate & database')
    `);
    expect(rows).toHaveLength(1);
  });
});

describe('likes', () => {
  it('accepts only an up-vote or a down-vote', async () => {
    const postId = await createPost();
    await expect(
      db.execute(sql`
        insert into likes (id, user_id, post_id, value)
        values (${uuidv7()}, 'voter', ${postId}, 2)
      `)
    ).rejects.toThrow();
  });

  it('allows one vote per (user, post)', async () => {
    const postId = await createPost();
    await db.insert(likes).values({ userId: 'voter', postId, value: 1 });

    let caught: unknown;
    try {
      await db.insert(likes).values({ userId: 'voter', postId, value: -1 });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'likes_user_id_post_id_key')).toBe(true);
  });

  it('is deleted with its post', async () => {
    const postId = await createPost();
    await db.insert(likes).values({ userId: 'voter', postId, value: 1 });
    await db.delete(posts).where(eq(posts.id, postId));
    createdPostIds.pop();

    const rows = await db.select({ id: likes.id }).from(likes).where(eq(likes.postId, postId));
    // `deletePost` already does this by hand; the constraint makes it impossible
    // to forget on a new deletion path.
    expect(rows).toEqual([]);
  });
});

describe('post self-references', () => {
  it('deletes a boost with its original', async () => {
    const original = await createPost();
    const [boost] = await db
      .insert(posts)
      .values({ oxyUserId: 'booster', type: 'boost', boostOf: original })
      .returning({ id: posts.id });

    await db.delete(posts).where(eq(posts.id, original));
    createdPostIds.pop();

    const rows = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, boost.id));
    // A `type:'boost'` row has an intentionally EMPTY body; with the original
    // gone it can only ever render blank.
    expect(rows).toEqual([]);
  });

  it('keeps a quote when the quoted post goes, and clears the pointer', async () => {
    const quoted = await createPost();
    const [quote] = await db
      .insert(posts)
      .values({ oxyUserId: 'quoter', type: 'quote', quoteOf: quoted })
      .returning({ id: posts.id });
    createdPostIds.push(quote.id);

    await db.delete(posts).where(eq(posts.id, quoted));
    createdPostIds.splice(createdPostIds.indexOf(quoted), 1);

    const rows = await db
      .select({ id: posts.id, quoteOf: posts.quoteOf })
      .from(posts)
      .where(eq(posts.id, quote.id));
    // A quote has a body of its own and must outlive its subject.
    expect(rows).toHaveLength(1);
    expect(rows[0].quoteOf).toBeNull();
  });
});

describe('threadgate_allow_rules', () => {
  it('requires a list id for `listOnly` and forbids one otherwise', async () => {
    const postUri = `mtn://oxy-user/app.mention.feed.post/${uuidv7()}`;
    const [gate] = await db
      .insert(threadgates)
      .values({ postUri, postId: 'post-1', createdBy: 'oxy-user' })
      .returning({ id: threadgates.id });

    await expect(
      db
        .insert(threadgateAllowRules)
        .values({ threadgateId: gate.id, position: 0, type: 'listOnly' })
    ).rejects.toThrow();

    await expect(
      db.insert(threadgateAllowRules).values({
        threadgateId: gate.id,
        position: 0,
        type: 'followingOnly',
        listId: 'some-list',
      })
    ).rejects.toThrow();

    await db
      .insert(threadgateAllowRules)
      .values({ threadgateId: gate.id, position: 0, type: 'listOnly', listId: 'some-list' });

    await db.delete(threadgates).where(eq(threadgates.id, gate.id));
  });
});

describe('user_settings.profile_media', () => {
  it('refuses a row that is half song and half podcast', async () => {
    // Mongo got this mutual exclusion for free by storing ONE subdocument.
    // Flattened into columns it has to be stated.
    await expect(
      db.insert(userSettings).values({
        oxyUserId: `mixed-${uuidv7()}`,
        profileMediaType: 'song',
        profileMediaTitle: 'A Song',
        profileMediaSyraTrackId: 'track-1',
        profileMediaPreviewUrl: 'https://example.invalid/preview.mp3',
        profileMediaSyraPodcastId: 'show-1',
      })
    ).rejects.toThrow();
  });

  it('accepts a complete song and a complete podcast', async () => {
    const songOwner = `song-${uuidv7()}`;
    const podcastOwner = `podcast-${uuidv7()}`;
    await db.insert(userSettings).values([
      {
        oxyUserId: songOwner,
        profileMediaType: 'song',
        profileMediaTitle: 'A Song',
        profileMediaSyraTrackId: 'track-1',
        profileMediaPreviewUrl: 'https://example.invalid/preview.mp3',
      },
      {
        oxyUserId: podcastOwner,
        profileMediaType: 'podcast',
        profileMediaTitle: 'A Show',
        profileMediaSyraPodcastId: 'show-1',
        profileMediaShowUrl: 'https://example.invalid/show',
      },
    ]);

    await db.delete(userSettings).where(eq(userSettings.oxyUserId, songOwner));
    await db.delete(userSettings).where(eq(userSettings.oxyUserId, podcastOwner));
  });
});
