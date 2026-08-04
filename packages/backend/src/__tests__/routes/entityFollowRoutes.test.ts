/**
 * `/entity-follows`, driven through the real router against real rows.
 *
 * The suite this replaces stubbed `EntityFollow.prototype.save` and asserted it
 * had been CALLED. That could not see a row at all — not its canonical form, not
 * the unique constraint, and not the order a page comes back in.
 *
 * Four things must hold.
 *
 * 1. It accepts EXACTLY the entity kinds something reads back. `hashtag` feeds
 *    ranking (affinity + candidate sourcing) and `list` is a feed subscription
 *    (`ListSubscriptionService` + the feed controller's merge). `feed` and
 *    `topic` used to be accepted and had NO reader anywhere: a row was written
 *    and never queried again. A custom-feed subscription is a `FeedLike`
 *    (`POST /feeds/:id/like`), so the route must reject `feed` outright rather
 *    than quietly accept a write nothing will ever honor.
 *
 * 2. Subscribing to a list obeys the SAME visibility rule as reading it. This
 *    write merges the list's members into the subscriber's feed and mutates the
 *    list's `subscriber_count`; ungated, it let any authenticated user subscribe
 *    to a stranger's private list and infer its membership from whose posts then
 *    appeared in their For You.
 *
 * 3. A followed hashtag is stored in ONE canonical form, so the unique
 *    constraint can actually fire.
 *
 * 4. The listing is NEWEST FIRST on a TOTAL order. Mongo got both for free from
 *    a descending `_id` sort; a `text` primary key gives neither, which is what
 *    the ordering block at the bottom is about.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { accountLists } from '../../db/schema/lists';
import { ENTITY_FOLLOW_TYPES, entityFollows } from '../../db/schema/engagement';
import { uuidv7 } from '../../db/schema/columns';
import { canViewList } from '../../services/listAccess';
import entityFollowRouter from '../../routes/entity-follow.routes';

let db: Database;

const run = randomUUID();
const VIEWER_ID = `viewer-${run}`;
const OTHER_USER_ID = `stranger-${run}`;

const createdListIds: string[] = [];

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  req.user = { id: VIEWER_ID };
  next();
});
app.use('/entity-follows', entityFollowRouter);

/** A list owned by `OTHER_USER_ID` unless told otherwise. */
async function makeList(isPublic: boolean, ownerOxyUserId = OTHER_USER_ID): Promise<string> {
  const [list] = await db
    .insert(accountLists)
    .values({ ownerOxyUserId, title: `List ${randomUUID()}`, isPublic })
    .returning({ id: accountLists.id, subscriberCount: accountLists.subscriberCount });
  createdListIds.push(list.id);
  return list.id;
}

async function readSubscriberCount(listId: string): Promise<number> {
  const [row] = await db
    .select({ subscriberCount: accountLists.subscriberCount })
    .from(accountLists)
    .where(eq(accountLists.id, listId));
  return row.subscriberCount;
}

async function readFollows(): Promise<Array<{ entityType: string; entityId: string }>> {
  return db
    .select({ entityType: entityFollows.entityType, entityId: entityFollows.entityId })
    .from(entityFollows)
    .where(eq(entityFollows.userId, VIEWER_ID));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  await db.delete(entityFollows).where(eq(entityFollows.userId, VIEWER_ID));
  if (createdListIds.length > 0) {
    await db.delete(accountLists).where(inArray(accountLists.id, createdListIds));
    createdListIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('entity-follow routes — accepted entity types', () => {
  it('exposes only the entity kinds that have a reader', () => {
    expect([...ENTITY_FOLLOW_TYPES]).toEqual(['hashtag', 'list']);
  });

  it.each(['feed', 'topic'])('rejects the dead entity type %s', async (entityType) => {
    const res = await request(app).post('/entity-follows').send({ entityType, entityId: 'entity-1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('entityType must be one of: hashtag, list');
    // The row is never written — not even optimistically.
    expect(await readFollows()).toEqual([]);
  });

  it('rejects a feed follow on every entry point of the route', async () => {
    const status = await request(app)
      .get('/entity-follows/status')
      .query({ entityType: 'feed', entityId: 'feed-1' });
    expect(status.status).toBe(400);

    const list = await request(app).get('/entity-follows').query({ type: 'feed' });
    expect(list.status).toBe(400);

    const unfollow = await request(app)
      .delete('/entity-follows')
      .send({ entityType: 'feed', entityId: 'feed-1' });
    expect(unfollow.status).toBe(400);
  });

  it('still follows a hashtag, and touches no list', async () => {
    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'design' });

    expect(res.status).toBe(201);
    expect(await readFollows()).toEqual([{ entityType: 'hashtag', entityId: 'design' }]);
    // The row it reports back is the row it wrote, and it carries `_id` because
    // a Mongoose document did.
    expect(res.body.follow).toMatchObject({ userId: VIEWER_ID, entityType: 'hashtag', entityId: 'design' });
    expect(res.body.follow._id).toBe(res.body.follow.id);
  });

  it('still subscribes to a public list, and bumps its subscriber count', async () => {
    const listId = await makeList(true);

    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: listId });

    expect(res.status).toBe(201);
    expect(await readSubscriberCount(listId)).toBe(1);
  });

  it('refuses a duplicate follow with 409, leaving exactly one row', async () => {
    await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });
    const second = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'design' });

    expect(second.status).toBe(409);
    expect(second.body.message).toBe('Already following this entity');
    expect(await readFollows()).toHaveLength(1);
  });
});

/**
 * The access-control half. Each case names the rule it guards, so a failure
 * reads as "the private-list gate is gone", not "some list test broke".
 */
describe('entity-follow routes — a list subscription obeys list visibility', () => {
  it('refuses to subscribe a stranger to a PRIVATE list, and writes nothing', async () => {
    const listId = await makeList(false);

    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: listId });

    expect(res.status).toBe(403);
    // The row is what leaks membership into the feed — it must never be written.
    expect(await readFollows()).toEqual([]);
    // ...and someone else's list must not be mutated either.
    expect(await readSubscriberCount(listId)).toBe(0);
  });

  it('lets the OWNER subscribe to their own private list', async () => {
    const listId = await makeList(false, VIEWER_ID);

    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: listId });

    expect(res.status).toBe(201);
    expect(await readSubscriberCount(listId)).toBe(1);
  });

  it('404s a list that does not exist, and writes nothing', async () => {
    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: uuidv7() });

    expect(res.status).toBe(404);
    expect(await readFollows()).toEqual([]);
  });

  it('still lets a subscriber unsubscribe from a list that has since gone private', async () => {
    const listId = await makeList(true);
    await request(app).post('/entity-follows').send({ entityType: 'list', entityId: listId });
    await db.update(accountLists).set({ isPublic: false }).where(eq(accountLists.id, listId));

    const res = await request(app)
      .delete('/entity-follows')
      .send({ entityType: 'list', entityId: listId });

    // Teardown has to converge: gating this would strand the row forever, and
    // the stranded row keeps feeding the list's members into the viewer's feed.
    expect(res.status).toBe(200);
    expect(await readFollows()).toEqual([]);
    expect(await readSubscriberCount(listId)).toBe(0);
  });

  it('404s an unfollow of something the viewer never followed', async () => {
    const res = await request(app)
      .delete('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'design' });

    expect(res.status).toBe(404);
  });
});

/** The rule itself, independent of any route. */
describe('canViewList', () => {
  it.each([
    ['a public list, to anyone', { isPublic: true, ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, true],
    ['a private list, to its owner', { isPublic: false, ownerOxyUserId: VIEWER_ID }, VIEWER_ID, true],
    ['a private list, to a stranger', { isPublic: false, ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, false],
    ['a private list, to nobody', { isPublic: false, ownerOxyUserId: OTHER_USER_ID }, undefined, false],
    ['a public list, to nobody', { isPublic: true, ownerOxyUserId: OTHER_USER_ID }, undefined, true],
    ['a list missing isPublic, to a stranger', { ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, false],
  ])('%s', (_label, list, viewerId, expected) => {
    expect(canViewList(list, viewerId)).toBe(expected);
  });
});

describe('entity-follow routes — write inputs are bounded', () => {
  it('rejects a non-string entityId', async () => {
    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: { $ne: null } });

    expect(res.status).toBe(400);
    expect(await readFollows()).toEqual([]);
  });

  it('rejects an over-long entityId', async () => {
    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(await readFollows()).toEqual([]);
  });

  it('still accepts a hashtag at the length bound', async () => {
    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'x'.repeat(100) });

    expect(res.status).toBe(201);
    expect(await readFollows()).toHaveLength(1);
  });
});

/**
 * A followed hashtag is stored in ONE canonical form.
 *
 * The write path used to store whatever the client sent while both readers
 * lowercased at read time, and the hashtag screen sends the URL segment
 * un-normalized — so `/hashtag/Design` and `/hashtag/design` wrote two rows for
 * one viewer, straight past the unique constraint on
 * `{userId, entityType, entityId}`. Each row was then counted again by the
 * affinity signals, and an unfollow removed only the casing it arrived by.
 */
describe('entity-follow routes — a followed hashtag is stored canonically', () => {
  it.each([
    ['upper case', 'Design', 'design'],
    ['mixed case', 'DeSiGn', 'design'],
    ['a leading hash', '#design', 'design'],
    ['surrounding whitespace', '  design  ', 'design'],
    ['punctuation', 'my-tag', 'mytag'],
    ['spaces between words', 'the village', 'thevillage'],
    ['an emoji separator', 'design✨', 'design'],
    ['a non-ASCII tag', '#Café', 'café'],
  ])('stores %s as the canonical tag', async (_label, sent, stored) => {
    const res = await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: sent });

    expect(res.status).toBe(201);
    // The row it reports back is the row it wrote — and the row really in the table.
    expect(res.body.follow.entityId).toBe(stored);
    expect(await readFollows()).toEqual([{ entityType: 'hashtag', entityId: stored }]);
  });

  it('collapses two casings of one tag onto a single row', async () => {
    const first = await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'Design' });
    const second = await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });

    expect(first.status).toBe(201);
    // Without canonicalization this is a second row that the unique constraint
    // never sees, and an unfollow then removes only one of them.
    expect(second.status).toBe(409);
    expect(await readFollows()).toEqual([{ entityType: 'hashtag', entityId: 'design' }]);
  });

  it('rejects a tag that canonicalizes to nothing', async () => {
    const res = await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: '#!!!' });

    expect(res.status).toBe(400);
    expect(await readFollows()).toEqual([]);
  });

  it('unfollows by the canonical tag, so the casing sent does not matter', async () => {
    await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });

    const res = await request(app)
      .delete('/entity-follows')
      .send({ entityType: 'hashtag', entityId: '#Design' });

    expect(res.status).toBe(200);
    expect(await readFollows()).toEqual([]);
  });

  it('reads status by the canonical tag, so a follow it just wrote is found', async () => {
    await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });

    const res = await request(app)
      .get('/entity-follows/status')
      .query({ entityType: 'hashtag', entityId: 'Design' });

    expect(res.status).toBe(200);
    expect(res.body.isFollowing).toBe(true);
  });

  it('leaves a LIST id untouched — normalization is for tags, not ids', async () => {
    const listId = await makeList(true);

    const res = await request(app)
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: listId });

    expect(res.status).toBe(201);
    // A uuid v7 must survive verbatim: `normalizeHashtag` strips the hyphens out
    // of one, and the id would then match no list.
    expect(res.body.follow.entityId).toBe(listId);
  });
});

/**
 * The listing's ORDER, which is the part of this route the storage change could
 * silently break.
 */
describe('GET /entity-follows — newest first, on a total order', () => {
  /** Insert a row with an explicit id and timestamp, bypassing the route. */
  async function seedFollow(entityId: string, createdAt: Date, id: string): Promise<void> {
    await db.insert(entityFollows).values({
      id,
      userId: VIEWER_ID,
      entityType: 'hashtag',
      entityId,
      createdAt,
      updatedAt: createdAt,
    });
  }

  it('puts a NEW uuid-v7 row above an OLD ObjectId row', async () => {
    /**
     * THE regression test for the sort axis. Mongo ordered on `_id`, and an
     * ObjectId embeds its creation time, so `_id desc` WAS newest-first. A `text`
     * id is not: a post-cutover uuid v7 begins `0198…` and an ObjectId minted in
     * 2024 begins `65b0…`, so ordering on the id alone files every NEW follow
     * BELOW every old one — silently, and only after the cutover.
     */
    await seedFollow('older', new Date('2024-01-01T00:00:00.000Z'), '65b0c9178fcdefaf81988ffb');
    await seedFollow('newer', new Date('2026-01-01T00:00:00.000Z'), '0198a2b1-4c3d-7e2f-8a1b-0123456789ab');

    const res = await request(app).get('/entity-follows').expect(200);

    expect(res.body.follows.map((f: { entityId: string }) => f.entityId)).toEqual(['newer', 'older']);
  });

  it('orders rows sharing a timestamp by id, descending', async () => {
    // Inserted in ASCENDING id order, so physical order is the exact opposite of
    // the order the route must produce. Drop `id` from the ORDER BY and the sort
    // has nothing left to distinguish these six rows by.
    const tied = new Date('2026-02-02T00:00:00.000Z');
    for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await seedFollow(`tag-${suffix}`, tied, `0198a2b1-4c3d-7e2f-8a1b-00000000000${suffix}`);
    }

    const res = await request(app).get('/entity-follows').expect(200);

    expect(res.body.follows.map((f: { entityId: string }) => f.entityId)).toEqual([
      'tag-f', 'tag-e', 'tag-d', 'tag-c', 'tag-b', 'tag-a',
    ]);
  });

  it('pages through rows sharing a timestamp without repeating or skipping one', async () => {
    const tied = new Date('2026-03-03T00:00:00.000Z');
    for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
      await seedFollow(`tag-${suffix}`, tied, `0198a2b1-4c3d-7e2f-8a1b-00000000000${suffix}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const query: Record<string, string | number> = { limit: 1 };
      if (cursor) query.cursor = cursor;
      const res = await request(app).get('/entity-follows').query(query).expect(200);
      seen.push(...res.body.follows.map((f: { entityId: string }) => f.entityId));
      cursor = res.body.nextCursor;
      if (!res.body.hasMore) break;
    }

    expect(seen).toEqual(['tag-e', 'tag-d', 'tag-c', 'tag-b', 'tag-a']);
    expect(new Set(seen).size).toBe(5);
  });

  it('narrows by type, and reports hasMore honestly', async () => {
    const listId = await makeList(true);
    await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });
    await request(app).post('/entity-follows').send({ entityType: 'list', entityId: listId });

    const hashtags = await request(app).get('/entity-follows').query({ type: 'hashtag' }).expect(200);
    expect(hashtags.body.follows.map((f: { entityId: string }) => f.entityId)).toEqual(['design']);
    expect(hashtags.body.hasMore).toBe(false);
    expect(hashtags.body.nextCursor).toBeUndefined();
  });

  it('400s a cursor it did not issue, rather than silently serving page one', async () => {
    /**
     * A cursor quietly ignored makes an infinite-scroll client loop over the
     * first page forever, with no error anywhere to explain it.
     */
    await request(app).post('/entity-follows').send({ entityType: 'hashtag', entityId: 'design' });

    const res = await request(app).get('/entity-follows').query({ cursor: 'not-a-cursor' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('cursor is malformed');
  });
});

describe('entity-follow routes — the entity followers endpoint is gone', () => {
  /**
   * It enumerated the followers of any entity to any authenticated caller: a
   * private list's subscriber roster, and by name everyone following a given
   * hashtag (a sensitive-interest inference, since hashtag follows appear in no
   * UI). Nothing called it. It must stay absent, not come back gated.
   */
  it.each(['list', 'hashtag'])('404s for %s', async (entityType) => {
    const res = await request(app).get(`/entity-follows/${entityType}/${uuidv7()}/followers`);
    expect(res.status).toBe(404);
  });
});
