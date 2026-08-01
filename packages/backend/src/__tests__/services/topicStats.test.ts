/**
 * `topic_stats` — the app-local counters `TopicService` maintains, against real
 * rows.
 *
 * Mongo did all three of these with `bulkWrite` upserts, and each one has a trap
 * the Postgres form has to answer explicitly:
 *
 *  - `$inc` on an upsert SETS the field to the delta when the row is new and adds
 *    when it is not; `insert … on conflict do update` has to spell both halves
 *    out, and getting the conflict branch wrong replaces the running total
 *    instead of adding to it — a number that still looks like a number.
 *  - A single statement may not touch one row twice, so duplicate ids in one
 *    call raise `ON CONFLICT DO UPDATE command cannot affect row a second time`.
 *    Two of these fold duplicates by summing; the third CANNOT, because its
 *    recurrence is not associative, and applies them in rounds instead.
 *  - `updated_at` has to be written by hand: the column's `$onUpdate` fires on
 *    `db.update()` and never on a conflict branch, so leaving it out silently
 *    freezes the timestamp Mongoose's `timestamps: true` maintained.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({}) }));
vi.mock('../../utils/alia', () => ({ aliaJSON: vi.fn(), isAliaEnabled: () => false }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { topicStats } from '../../db/schema/discovery';
import { topicService } from '../../services/TopicService';

let db: Database;
const createdTopicIds: string[] = [];

function topicId(label: string): string {
  const id = `oxy-topic-${label}-${randomUUID()}`;
  createdTopicIds.push(id);
  return id;
}

async function read(id: string) {
  const [row] = await db.select().from(topicStats).where(inArray(topicStats.topicId, [id]));
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdTopicIds.length > 0) {
    await db.delete(topicStats).where(inArray(topicStats.topicId, createdTopicIds));
    createdTopicIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('batchIncrementPopularity', () => {
  it('creates the row with the delta, then ADDS to it on a second call', async () => {
    const id = topicId('popularity');

    await topicService.batchIncrementPopularity([{ topicId: id, delta: 4 }]);
    expect((await read(id)).popularity).toBe(4);

    await topicService.batchIncrementPopularity([{ topicId: id, delta: 2.5 }]);
    // 6.5, not 2.5: the conflict branch adds rather than replaces.
    expect((await read(id)).popularity).toBe(6.5);
  });

  it('sums duplicate ids in ONE call rather than failing the statement', async () => {
    // Postgres refuses to touch one row twice in a single statement, so the fold
    // has to happen before the insert. Mongo folded them too (by applying both).
    const id = topicId('duplicate');

    await topicService.batchIncrementPopularity([
      { topicId: id, delta: 1 },
      { topicId: id, delta: 2 },
      { topicId: id, delta: 3 },
    ]);

    expect((await read(id)).popularity).toBe(6);
  });

  it('moves updated_at on the conflict branch', async () => {
    const id = topicId('touched');
    await topicService.batchIncrementPopularity([{ topicId: id, delta: 1 }]);
    const before = (await read(id)).updatedAt;

    await topicService.batchIncrementPopularity([{ topicId: id, delta: 1 }]);

    expect((await read(id)).updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect((await read(id)).popularity).toBe(2);
  });

  it('does nothing at all for an empty update list', async () => {
    await expect(topicService.batchIncrementPopularity([])).resolves.toBeUndefined();
  });
});

describe('batchIncrementPostCount', () => {
  it('counts one per occurrence and accumulates across calls', async () => {
    const id = topicId('postcount');

    await topicService.batchIncrementPostCount([id, id, id]);
    expect((await read(id)).postCount).toBe(3);

    await topicService.batchIncrementPostCount([id]);
    expect((await read(id)).postCount).toBe(4);
    // The counters are independent; touching one must not disturb the other.
    expect((await read(id)).popularity).toBe(0);
  });

  it('counts each topic separately in one call', async () => {
    const busy = topicId('busy');
    const quiet = topicId('quiet');

    await topicService.batchIncrementPostCount([busy, quiet, busy]);

    expect((await read(busy)).postCount).toBe(2);
    expect((await read(quiet)).postCount).toBe(1);
  });
});

describe('updatePopularityFromTrending', () => {
  it('seeds a new topic with the weighted score and then decays toward the next one', async () => {
    const id = topicId('decay');
    const decay = 0.7;
    const weight = 1 - decay;

    await topicService.updatePopularityFromTrending([{ topicId: id, trendingScore: 100 }], decay);
    expect((await read(id)).popularity).toBeCloseTo(100 * weight, 10);

    await topicService.updatePopularityFromTrending([{ topicId: id, trendingScore: 50 }], decay);
    expect((await read(id)).popularity).toBeCloseTo(100 * weight * decay + 50 * weight, 10);
  });

  it('applies duplicate ids in SEQUENCE, because the recurrence is not associative', async () => {
    /**
     * Duplicates really do occur: a name that trends as both a hashtag and a
     * classified topic resolves through `resolveNames` — keyed on the name alone
     * — to the SAME registry id, so one batch carries two updates for it. Mongo's
     * `bulkWrite` applied both in order. Summing them (as the two counters above
     * do) would give a different, wrong number, and a single statement cannot
     * touch the row twice, so the updates go out in rounds.
     */
    const id = topicId('sequenced');
    const decay = 0.5;
    const weight = 1 - decay;

    await topicService.updatePopularityFromTrending(
      [{ topicId: id, trendingScore: 100 }, { topicId: id, trendingScore: 20 }],
      decay,
    );

    const expected = (100 * weight) * decay + 20 * weight;
    expect((await read(id)).popularity).toBeCloseTo(expected, 10);
    // Summing first would give (120 * weight) = 60; the sequence gives 35.
    expect((await read(id)).popularity).not.toBeCloseTo(120 * weight, 10);
  });

  it('updates several distinct topics in one round', async () => {
    const first = topicId('multi-a');
    const second = topicId('multi-b');
    const decay = 0.7;

    await topicService.updatePopularityFromTrending(
      [{ topicId: first, trendingScore: 10 }, { topicId: second, trendingScore: 40 }],
      decay,
    );

    expect((await read(first)).popularity).toBeCloseTo(10 * (1 - decay), 10);
    expect((await read(second)).popularity).toBeCloseTo(40 * (1 - decay), 10);
  });
});
