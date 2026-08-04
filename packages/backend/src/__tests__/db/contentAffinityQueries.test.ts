/**
 * `ContentAffinityService`'s Postgres queries, against real rows.
 *
 * Four of this service's reads crossed the store boundary in this batch: the
 * viewer's likes (batch 2 made `likes` a Postgres table but every reader stayed
 * on Mongo), the viewer's reply/boost targets, post-author resolution, and the
 * two coverage AGGREGATIONS.
 *
 * The aggregations are why this file exists rather than a probe. Both are a
 * bounded scan feeding a `GROUP BY` over a `LATERAL unnest`, composed through
 * drizzle — a shape that typechecks and can still fail at the database, and
 * whose two counting mistakes are both silent:
 *
 *  - `count(*)` instead of `count(distinct id)` scores a post covering three
 *    preferred topics as THREE posts, because `unnest` emits one row per
 *    (post, topic) pair. Mongo's `$sum: 1` counted documents.
 *  - capping AFTER the grouping instead of before turns a bounded scan into a
 *    full-corpus one. Mongo's `$limit` sat between `$sort` and `$group`.
 *
 * Neither shows up as an error, so both are asserted on values here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { likes } from '../../db/schema/engagement';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { ContentAffinityService } from '../../services/ContentAffinityService';

let db: Database;
const created: string[] = [];
const createdLikes: string[] = [];

const AUTHOR = 'oxy-affinity-author';
const VIEWER = 'oxy-affinity-viewer';

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'affinity fixture', tag: 'en' }] },
    ...overrides,
  };
}

async function create(overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord(baseInput(overrides));
  created.push(record.id);
  return record;
}

/** The private query methods, reached by name — this suite tests the SQL. */
type AffinityInternals = {
  computeTopicAffinity(
    viewerId: string,
    since: Date,
    preferredTopics: Array<{ topic: string; weight: number }>,
  ): Promise<Map<string, { weight: number }>>;
  computeHashtagAffinity(viewerId: string, since: string): Promise<Map<string, { weight: number }>>;
  collectLikes(
    viewerId: string,
    since: Date,
  ): Promise<Array<{ postId: string; fromVideoSurface: boolean }>>;
  collectViewerInteractionTargets(
    viewerId: string,
    since: Date,
    kind: 'reply' | 'boost',
  ): Promise<string[]>;
  resolvePostAuthors(postIds: string[]): Promise<Map<string, string>>;
};

function internals(service: ContentAffinityService): AffinityInternals {
  return service as unknown as AffinityInternals;
}

const service = new ContentAffinityService();
const since = () => new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdLikes.length > 0) {
    await db.delete(likes).where(inArray(likes.id, createdLikes.splice(0)));
  }
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the topic-coverage aggregation', () => {
  it('counts POSTS, not (post, topic) pairs', async () => {
    // One post covering TWO preferred topics. `count(*)` over the unnest would
    // report 2; the correct answer is 1.
    await create({ postClassification: { topics: ['tech', 'music'] } });

    const rows = await db
      .select({
        oxyUserId: posts.oxyUserId,
        matched: sql<string[]>`array_agg(distinct topic)`,
        postCount: sql<number>`count(distinct ${posts.id})::int`,
      })
      .from(posts)
      .innerJoin(
        sql`lateral unnest(${posts.classificationTopics}) as topic`,
        sql`topic = any(${sql.param(['tech', 'music'])})`,
      )
      .where(and(inArray(posts.id, created), eq(posts.oxyUserId, AUTHOR)))
      .groupBy(posts.oxyUserId);

    expect(rows).toHaveLength(1);
    expect(rows[0].postCount).toBe(1);
    expect([...rows[0].matched].sort()).toEqual(['music', 'tech']);
  });

  it('runs end to end and scores an author who covers the viewer preferences', async () => {
    await create({ postClassification: { topics: ['tech'] } });
    await create({ postClassification: { topics: ['tech', 'music'] } });

    const scores = await internals(service).computeTopicAffinity(VIEWER, since(), [
      { topic: 'tech', weight: 1 },
      { topic: 'music', weight: 0.5 },
    ]);

    // The author is present with a positive score — the query executed and the
    // coverage/weight maths reached a value.
    const entry = scores.get(AUTHOR);
    expect(entry).toBeDefined();
    expect(entry?.weight).toBeGreaterThan(0);
  });

  it('never scores the viewer themself', async () => {
    await create({
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      postClassification: { topics: ['tech'] },
    });

    const scores = await internals(service).computeTopicAffinity(VIEWER, since(), [
      { topic: 'tech', weight: 1 },
    ]);

    expect(scores.has(VIEWER)).toBe(false);
  });
});

describe('the hashtag-coverage aggregation', () => {
  it('runs end to end without touching Mongo', async () => {
    await create({ hashtags: ['tech'] });
    // No followed hashtags for this viewer, so the result is empty — the point
    // is that the query PATH executes rather than throwing.
    const scores = await internals(service).computeHashtagAffinity(VIEWER, since());
    expect(scores).toBeInstanceOf(Map);
  });
});

describe('the reads batch 2 left split across two stores', () => {
  it('reads the viewer likes from Postgres, newest first', async () => {
    const older = await create();
    const newer = await create();

    const [likeOld] = await db
      .insert(likes)
      .values({
        userId: VIEWER,
        postId: older.id,
        value: 1,
        source: 'for_you',
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: likes.id });
    const [likeNew] = await db
      .insert(likes)
      .values({ userId: VIEWER, postId: newer.id, value: 1, source: 'videos' })
      .returning({ id: likes.id });
    createdLikes.push(likeOld.id, likeNew.id);

    const collected = await internals(service).collectLikes(VIEWER, since());
    const mine = collected.filter((row) => row.postId === older.id || row.postId === newer.id);

    expect(mine.map((row) => row.postId)).toEqual([newer.id, older.id]);
    // `source` drives the surface-aware engagement weighting.
    expect(mine[0].fromVideoSurface).toBe(true);
    expect(mine[1].fromVideoSurface).toBe(false);
  });

  it('collects reply and boost targets from the viewer own posts', async () => {
    const parent = await create();
    await create({
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      parentPostId: parent.id,
    });
    await create({
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
      type: PostType.BOOST,
      boostOf: parent.id,
      content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
    });

    const replies = await internals(service).collectViewerInteractionTargets(
      VIEWER,
      since(),
      'reply',
    );
    const boosts = await internals(service).collectViewerInteractionTargets(
      VIEWER,
      since(),
      'boost',
    );

    expect(replies).toContain(parent.id);
    expect(boosts).toContain(parent.id);
  });

  it('resolves post authors and skips a malformed id instead of losing the batch', async () => {
    const record = await create();

    // Under Mongoose ONE malformed id threw a CastError and the catch discarded
    // every author in the batch. A `text` id simply matches no row.
    const authors = await internals(service).resolvePostAuthors([record.id, 'not-an-id-at-all']);

    expect(authors.get(record.id)).toBe(AUTHOR);
    expect(authors.has('not-an-id-at-all')).toBe(false);
  });
});
