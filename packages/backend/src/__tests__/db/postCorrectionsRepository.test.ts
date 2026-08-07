/**
 * The correction trail against real rows.
 *
 * Every property here is a claim about what Postgres actually stores, and the
 * suite around this one is largely mocked — so a mocked test of this module
 * would be a test of the mock. Four of the five properties below are only
 * expressible against a live server:
 *
 *  - **The revision number comes from the counter, not from a row count.**
 *    Retention deletes rows, so `count(*) + 1` would start REISSUING revision
 *    numbers that already exist and collide with the unique index. Only a run
 *    that actually evicts rows can tell the two implementations apart, which is
 *    why the retention case deliberately pushes past the cap rather than
 *    asserting the arithmetic in isolation.
 *  - **`correction_count` outlives the rows it counted.** The whole reason the
 *    counter is a column is that a publication must not be able to look like it
 *    rewrote itself fewer times than it did.
 *  - **`ON DELETE CASCADE` really is on the constraint.** The schema source says
 *    so; the database is what enforces it.
 *  - **`listPostCorrections` cannot leak the corrector.** That one is enforced at
 *    the type level too, but the type only constrains this codebase — the
 *    assertion here is that the VALUE never reaches a response.
 *
 * Every fixture id carries a per-file prefix: one database serves the whole run,
 * so a literal author id would collide with whatever a sibling file wrote.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postCorrections } from '../../db/schema/postContent';
import {
  MAX_RETAINED_POST_CORRECTIONS,
  listPostCorrections,
  recordPostCorrection,
} from '../../db/posts/postCorrectionsRepository';

/** This file's private namespace — see the docblock. */
const NS = 'post-corrections-repo-test';
const CHANNEL = `${NS}-channel`;
const WRITER = `${NS}-writer`;

let db: Database;
const createdPostIds: string[] = [];

async function createPost(): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({ oxyUserId: CHANNEL })
    .returning({ id: posts.id });
  createdPostIds.push(row.id);
  return row.id;
}

async function readSummary(postId: string): Promise<{
  correctionCount: number;
  lastCorrectedAt: Date | null;
}> {
  const [row] = await db
    .select({
      correctionCount: posts.correctionCount,
      lastCorrectedAt: posts.lastCorrectedAt,
    })
    .from(posts)
    .where(eq(posts.id, postId));
  return row;
}

/** Record one correction, with a distinct timestamp so ordering is observable. */
async function correct(postId: string, previousText: string, atMs: number) {
  return recordPostCorrection({
    postId,
    previousText,
    correctedByOxyUserId: WRITER,
    correctedAt: new Date(atMs),
  });
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

describe('recordPostCorrection', () => {
  it('starts a fresh post at zero corrections and no correction time', async () => {
    const postId = await createPost();

    expect(await readSummary(postId)).toEqual({ correctionCount: 0, lastCorrectedAt: null });
    expect(await listPostCorrections(postId)).toEqual([]);
  });

  it('numbers revisions from 1 and moves the post summary with each one', async () => {
    const postId = await createPost();

    const first = await correct(postId, 'as published', 1_700_000_000_000);
    expect(first).toEqual({
      revision: 1,
      correctionCount: 1,
      correctedAt: new Date(1_700_000_000_000),
    });
    expect(await readSummary(postId)).toEqual({
      correctionCount: 1,
      lastCorrectedAt: new Date(1_700_000_000_000),
    });

    const second = await correct(postId, 'the first rewrite', 1_700_000_060_000);
    expect(second?.revision).toBe(2);
    expect(await readSummary(postId)).toEqual({
      correctionCount: 2,
      lastCorrectedAt: new Date(1_700_000_060_000),
    });
  });

  it('records the body that was SUPERSEDED, oldest first', async () => {
    const postId = await createPost();

    await correct(postId, 'as published', 1_700_000_000_000);
    await correct(postId, 'the first rewrite', 1_700_000_060_000);

    expect(await listPostCorrections(postId)).toEqual([
      {
        revision: 1,
        previousText: 'as published',
        correctedAt: new Date(1_700_000_000_000).toISOString(),
      },
      {
        revision: 2,
        previousText: 'the first rewrite',
        correctedAt: new Date(1_700_000_060_000).toISOString(),
      },
    ]);
  });

  it('never serves the writer who made the correction, though it stores one', async () => {
    const postId = await createPost();
    await correct(postId, 'as published', 1_700_000_000_000);

    // Stored: the audit value is really on the row...
    const [stored] = await db
      .select({ correctedByOxyUserId: postCorrections.correctedByOxyUserId })
      .from(postCorrections)
      .where(eq(postCorrections.postId, postId));
    expect(stored.correctedByOxyUserId).toBe(WRITER);

    // ...and absent from every served field. Asserted as "no value anywhere in
    // the response" rather than "no `correctedBy` key", so renaming the field
    // could not make this pass while still shipping the id.
    const served = await listPostCorrections(postId);
    expect(JSON.stringify(served)).not.toContain(WRITER);
  });

  it('answers null for a post that does not exist, without writing anything', async () => {
    expect(await correct(`${NS}-no-such-post`, 'nothing', 1_700_000_000_000)).toBeNull();
    expect(await listPostCorrections(`${NS}-no-such-post`)).toEqual([]);
  });

  it('refuses a duplicate revision number for one post', async () => {
    const postId = await createPost();
    await correct(postId, 'as published', 1_700_000_000_000);

    await expect(
      db.insert(postCorrections).values({
        postId,
        revision: 1,
        previousText: 'a second revision 1',
        correctedByOxyUserId: WRITER,
        createdAt: new Date(1_700_000_060_000),
      }),
    ).rejects.toThrow();
  });

  it('refuses a revision below 1', async () => {
    const postId = await createPost();

    await expect(
      db.insert(postCorrections).values({
        postId,
        revision: 0,
        previousText: 'not a revision',
        correctedByOxyUserId: WRITER,
        createdAt: new Date(1_700_000_000_000),
      }),
    ).rejects.toThrow();
  });

  it('deletes the trail with the post', async () => {
    const postId = await createPost();
    await correct(postId, 'as published', 1_700_000_000_000);
    expect(await listPostCorrections(postId)).toHaveLength(1);

    await db.delete(posts).where(eq(posts.id, postId));
    createdPostIds.pop();

    const remaining = await getDb()
      .select({ id: postCorrections.id })
      .from(postCorrections)
      .where(eq(postCorrections.postId, postId));
    expect(remaining).toEqual([]);
  });
});

describe('retention', () => {
  it('keeps everything up to the cap', async () => {
    const postId = await createPost();

    for (let n = 1; n <= MAX_RETAINED_POST_CORRECTIONS; n += 1) {
      await correct(postId, `version ${n}`, 1_700_000_000_000 + n);
    }

    const retained = await listPostCorrections(postId);
    expect(retained).toHaveLength(MAX_RETAINED_POST_CORRECTIONS);
    expect(retained[0].revision).toBe(1);
    expect(retained.at(-1)?.revision).toBe(MAX_RETAINED_POST_CORRECTIONS);
  });

  it('past the cap, keeps the post AS PUBLISHED and evicts the oldest middle', async () => {
    const postId = await createPost();

    const overshoot = 3;
    const total = MAX_RETAINED_POST_CORRECTIONS + overshoot;
    for (let n = 1; n <= total; n += 1) {
      await correct(postId, `version ${n}`, 1_700_000_000_000 + n);
    }

    const retained = await listPostCorrections(postId);

    // The set stays exactly at the cap, however far past it the post goes.
    expect(retained).toHaveLength(MAX_RETAINED_POST_CORRECTIONS);

    // Revision 1 is the post as it was PUBLISHED — the one version a correction
    // trail exists to preserve — so it survives eviction by name.
    expect(retained[0]).toMatchObject({ revision: 1, previousText: 'version 1' });

    // What went is the oldest INTERMEDIATE run, and the surviving revision
    // numbers say so: 1, then a gap, then an unbroken tail to the newest.
    expect(retained.map((entry) => entry.revision)).toEqual([
      1,
      ...Array.from({ length: MAX_RETAINED_POST_CORRECTIONS - 1 }, (_, i) => total - (MAX_RETAINED_POST_CORRECTIONS - 2) + i),
    ]);
    expect(retained[1].revision).toBeGreaterThan(2);
  });

  it('counts corrections MADE, not rows retained', async () => {
    const postId = await createPost();

    const total = MAX_RETAINED_POST_CORRECTIONS + 5;
    for (let n = 1; n <= total; n += 1) {
      await correct(postId, `version ${n}`, 1_700_000_000_000 + n);
    }

    // The property the whole design rests on: the counter keeps climbing while
    // the retained set is capped, so truncation can never make a publication
    // look like it rewrote itself less often than it did.
    const summary = await readSummary(postId);
    expect(summary.correctionCount).toBe(total);
    expect(await listPostCorrections(postId)).toHaveLength(MAX_RETAINED_POST_CORRECTIONS);
    expect(summary.correctionCount).toBeGreaterThan(MAX_RETAINED_POST_CORRECTIONS);
  });
});
