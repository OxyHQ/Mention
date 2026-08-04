/**
 * The trending batch WRITE and the reads that hang off it, against real rows.
 *
 * This is the path that froze `GET /trending` on one batch for over a day while
 * answering HTTP 200 the whole time, and two independent defects met there:
 *
 *   1. Batch uniqueness was keyed on `{ name, calculatedAt }`, so a name trending
 *      as BOTH a hashtag and a classified topic (observed in production for
 *      `business`) was a duplicate. The key now carries `type`.
 *
 *   2. The insert was ORDERED and its rejection propagated, so one bad row
 *      discarded every row after it AND skipped the `trend_batches` write — and
 *      since `getTrending` derives its timestamp from that table, the endpoint
 *      went on serving the last complete batch forever.
 *
 * Both are asserted against what is STORED, not against the shape of a call. The
 * suite this replaces mocked `insertMany` and checked that `{ ordered: false }`
 * was passed; it could not have noticed that a Postgres multi-row INSERT is
 * all-or-nothing and that the resilience has to be written out by hand.
 *
 * The wire format is the other subject. `_id`, an OMITTED `topicId`, and `Date`
 * (not string) timestamps are what Mongoose's `.lean()` produced, and the
 * frontend consumes this response directly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MtnConfig } from '@mention/shared-types';
import { asc, eq, inArray, lt } from 'drizzle-orm';

import { TrendingType } from '../../db/schema/discovery';

const mocks = vi.hoisted(() => ({
  resolveNames: vi.fn(),
  updatePopularityFromTrending: vi.fn(),
  emitTrendsUpdated: vi.fn(),
}));

// Redis absent: every cache branch short-circuits, so a read here always hits the
// database and a stale cache entry can never make an assertion pass.
vi.mock('../../utils/redis', () => ({ getRedisClient: () => null }));
vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: mocks.emitTrendsUpdated }));
vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), isAliaEnabled: () => false }));
vi.mock('../../services/TopicService', () => ({
  topicService: {
    resolveNames: mocks.resolveNames,
    updatePopularityFromTrending: mocks.updatePopularityFromTrending,
  },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { trendBatches, trending } from '../../db/schema/discovery';
import { posts } from '../../db/schema/posts';
import { trendingService } from '../../services/TrendingService';

interface TrendItemInput {
  type: 'hashtag' | 'topic' | 'entity';
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  topicId?: string;
  displayName?: string;
  category?: string;
  burstScore?: number;
  authorCount?: number;
  startedAt?: Date;
  status?: 'hot';
  actorIds?: string[];
  languages?: string[];
}

/**
 * `saveTrendingBatch` and `cleanupOldTrends` are private; reach them through a
 * typed structural view rather than `as any`, so the tests stay type-checked.
 */
type PrivateTrending = {
  saveTrendingBatch(
    items: TrendItemInput[],
    calculatedAt: Date,
  ): Promise<{ insertedCount: number; rejected: string[] }>;
  cleanupOldTrends(): Promise<void>;
};
const svc = trendingService as unknown as PrivateTrending;

let db: Database;
const createdPostIds: string[] = [];
const createdBatchStamps: Date[] = [];

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function item(overrides: Partial<TrendItemInput> & { name: string }): TrendItemInput {
  return {
    type: 'hashtag',
    displayName: overrides.name,
    category: 'other',
    description: '',
    score: 10,
    burstScore: 2,
    volume: 5,
    authorCount: 4,
    momentum: 0.5,
    startedAt: new Date(),
    actorIds: [],
    languages: [],
    // Every term the row stands for, its own name first. One element unless
    // co-occurrence merged it — and the writer only STORES the column when there
    // is more than one, so the default here is what an unmerged row looks like.
    terms: [overrides.name],
    ...overrides,
  };
}

/** A batch stamp unique to this test, tracked so the rows can be removed after. */
function batchStamp(offsetMs = 0): Date {
  const at = new Date(Date.now() + offsetMs);
  createdBatchStamps.push(at);
  return at;
}

async function seedPost(hashtags: string[], author?: string): Promise<void> {
  const [row] = await db
    .insert(posts)
    .values({
      status: 'published',
      visibility: 'public',
      // Inside the six-hour RECENT window, so the term bursts against its own
      // trailing rate rather than sitting flat.
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
      oxyUserId: author ?? null,
      hashtags,
    })
    .returning({ id: posts.id });
  createdPostIds.push(row.id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  if (createdBatchStamps.length > 0) {
    await db.delete(trending).where(inArray(trending.calculatedAt, createdBatchStamps));
    await db.delete(trendBatches).where(inArray(trendBatches.calculatedAt, createdBatchStamps));
    createdBatchStamps.length = 0;
  }
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('saveTrendingBatch — a collision costs ONE trend, never the batch', () => {
  it('stores a hashtag and a topic that share a name as TWO rows in one batch', async () => {
    /**
     * THE regression. Keyed on `{name, calculatedAt}` these two are duplicates;
     * with `type` in the key they are what they actually are — a hashtag someone
     * typed and a topic the classifier inferred, routing to different screens.
     */
    const name = uniqueName('business');
    const at = batchStamp();

    const write = await svc.saveTrendingBatch(
      [item({ name, type: 'hashtag', score: 20 }), item({ name, type: 'topic', score: 10 })],
      at,
    );

    expect(write).toEqual({ insertedCount: 2, rejected: [] });
    const stored = await db.select().from(trending).where(eq(trending.calculatedAt, at));
    expect(stored.map((row) => row.type).sort()).toEqual(['hashtag', 'topic']);
    // Rank is assigned over the score-sorted batch, which is what makes
    // `(score desc, rank asc)` a total order inside one batch.
    expect(stored.find((row) => row.type === 'hashtag')?.rank).toBe(1);
    expect(stored.find((row) => row.type === 'topic')?.rank).toBe(2);
  });

  it('keeps every OTHER row when one collides, and NAMES the one it dropped', async () => {
    /**
     * A Postgres multi-row INSERT is all-or-nothing, so `on conflict do nothing`
     * is what preserves the unordered-insert guarantee. Without it, the duplicate
     * below takes the two good trends down with it and the caller — which
     * publishes the batch only if something landed — stops publishing entirely.
     */
    const duplicated = uniqueName('dupe');
    const survivorA = uniqueName('survivor-a');
    const survivorB = uniqueName('survivor-b');
    const at = batchStamp();

    await svc.saveTrendingBatch([item({ name: duplicated, score: 99 })], at);

    const write = await svc.saveTrendingBatch(
      [
        item({ name: survivorA, score: 30 }),
        item({ name: duplicated, score: 20 }),
        item({ name: survivorB, score: 10 }),
      ],
      at,
    );

    expect(write.insertedCount).toBe(2);
    expect(write.rejected).toEqual([`hashtag:${duplicated}`]);
    const stored = await db.select().from(trending).where(eq(trending.calculatedAt, at));
    expect(stored.map((row) => row.name).sort()).toEqual([duplicated, survivorA, survivorB].sort());
  });

  it('tolerates the same (name, type) appearing TWICE inside one batch', async () => {
    // Two hashtags that lowercase to one name — the shape `aggregateHashtags`
    // can still produce, since it groups on the stored casing and lowercases
    // afterwards. Mongo errored on the second; `DO NOTHING` also sees rows this
    // very command inserted, so it is skipped instead.
    const name = uniqueName('collide');
    const at = batchStamp();

    const write = await svc.saveTrendingBatch(
      [item({ name, score: 30 }), item({ name, score: 20 })],
      at,
    );

    expect(write.insertedCount).toBe(1);
    // Reported per ROW, not per distinct key: the second measurement really was
    // dropped, and `insertedCount + rejected.length` must still account for the
    // whole batch.
    expect(write.rejected).toEqual([`hashtag:${name}`]);
  });

  it('accounts for every row it was given, accepted or rejected', async () => {
    // The invariant behind the error log: a partial batch can never look whole.
    const clash = uniqueName('accounting');
    const fresh = uniqueName('accounting-fresh');
    const at = batchStamp();
    await svc.saveTrendingBatch([item({ name: clash })], at);

    const batch = [item({ name: clash }), item({ name: fresh }), item({ name: clash })];
    const write = await svc.saveTrendingBatch(batch, at);

    expect(write.insertedCount + write.rejected.length).toBe(batch.length);
    expect(write.rejected).toEqual([`hashtag:${clash}`, `hashtag:${clash}`]);
  });

  it('reports an empty batch without touching the database', async () => {
    expect(await svc.saveTrendingBatch([], batchStamp())).toEqual({
      insertedCount: 0,
      rejected: [],
    });
  });

  it('stores topicId when a trend resolved to a registry topic, and NULL otherwise', async () => {
    const linked = uniqueName('linked');
    const unlinked = uniqueName('unlinked');
    const at = batchStamp();

    await svc.saveTrendingBatch(
      [item({ name: linked, type: 'topic', topicId: 'oxy-topic-42' }), item({ name: unlinked })],
      at,
    );

    const stored = await db.select().from(trending).where(eq(trending.calculatedAt, at));
    const byName = new Map(stored.map((row) => [row.name, row]));
    expect(byName.get(linked)?.topicId).toBe('oxy-topic-42');
    expect(byName.get(unlinked)?.topicId).toBeNull();
  });
});

describe('getTrending — the wire format is the contract', () => {
  async function publishBatch(names: string[], at: Date, summary = 'a summary'): Promise<void> {
    await svc.saveTrendingBatch(
      names.map((name, index) => item({ name, score: 100 - index, volume: 10 - index })),
      at,
    );
    await db.insert(trendBatches).values({ calculatedAt: at, summary });
  }

  it('emits _id, Date timestamps, and OMITS topicId when there is none', async () => {
    /**
     * Mongoose's `.lean()` gave an ObjectId `_id` that JSON-serialized to a
     * string, `Date` instants, and NO `topicId` key at all when the field was
     * unset. Postgres would happily hand back `null` for that last one and a raw
     * timestamp STRING for the first two if the query bypassed drizzle's mappers.
     */
    const name = uniqueName('wire');
    const at = batchStamp();
    await publishBatch([name], at, 'the summary');

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === name);

    expect(trend).toBeDefined();
    expect(typeof trend?._id).toBe('string');
    expect(trend?._id.length).toBeGreaterThan(0);
    expect(trend?.calculatedAt).toBeInstanceOf(Date);
    expect(trend?.updatedAt).toBeInstanceOf(Date);
    expect(trend).not.toHaveProperty('topicId');
    // Mongo bookkeeping that no reader ever looked at must not reappear.
    expect(trend).not.toHaveProperty('__v');
    // The whole key set, pinned: a NULL column must be OMITTED rather than
    // emitted as `null` (the SDK's zod parse rejects a null where it expects
    // "not there"), so a key appearing here is a claim that the row really
    // carries a value.
    expect(Object.keys(trend ?? {}).sort()).toEqual([
      '_id', 'authorCount', 'burstScore', 'calculatedAt', 'category', 'description',
      'displayName', 'momentum', 'name', 'rank', 'score', 'startedAt', 'type',
      'updatedAt', 'volume',
    ]);
    // `actorIds` and `languages` are absent here BECAUSE the fixture's are
    // empty: `saveTrendingBatch` writes an empty list as NULL rather than as
    // `[]`, so the DTO omits the key. That is the same "absent, never null"
    // rule as `topicId`, and it is why an empty sample cannot be mistaken for a
    // resolved-to-nobody one.
    expect(trend).not.toHaveProperty('actorIds');
    expect(trend).not.toHaveProperty('languages');
    expect(result.summary).toBe('the summary');
    expect(result.recId).toEqual(expect.any(String));
  });

  it('carries topicId as a string when the trend resolved one', async () => {
    const name = uniqueName('wire-topic');
    const at = batchStamp();
    await svc.saveTrendingBatch([item({ name, type: 'topic', topicId: 'oxy-topic-7' })], at);
    await db.insert(trendBatches).values({ calculatedAt: at, summary: '' });

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === name);

    expect(trend?.topicId).toBe('oxy-topic-7');
  });

  it('serves the LATEST batch and can filter it by type', async () => {
    const older = uniqueName('older');
    const newer = uniqueName('newer');
    const newerTopic = uniqueName('newer-topic');
    await publishBatch([older], batchStamp(-60_000));

    const latest = batchStamp();
    await svc.saveTrendingBatch(
      [item({ name: newer, score: 50 }), item({ name: newerTopic, type: 'topic', score: 40 })],
      latest,
    );
    await db.insert(trendBatches).values({ calculatedAt: latest, summary: '' });

    const all = await trendingService.getTrending(500);
    expect(all.trending.map((row) => row.name)).toContain(newer);
    expect(all.trending.map((row) => row.name)).not.toContain(older);

    // The route hands the ENUM member through, not the plain stored string.
    const hashtagsOnly = await trendingService.getTrending(500, TrendingType.HASHTAG);
    expect(hashtagsOnly.trending.map((row) => row.name)).toContain(newer);
    expect(hashtagsOnly.trending.map((row) => row.name)).not.toContain(newerTopic);
  });

  it('does not surface a trend from a batch that was never published', async () => {
    // Vacuity floor: the reads above must not be passing because everything
    // passes. These rows exist but no `trend_batches` row points at them.
    const orphan = uniqueName('orphan');
    await svc.saveTrendingBatch([item({ name: orphan })], batchStamp(60_000));

    const result = await trendingService.getTrending(500);
    expect(result.trending.map((row) => row.name)).not.toContain(orphan);
  });
});

describe('loadVolumeSeries — one series per TERM, in time order', () => {
  it('reads volumes ordered by batch time', async () => {
    /**
     * Mongo's array happened to be in time order because the planner streamed a
     * matching index; `array_agg(... order by calculated_at)` states it. An
     * aggregate's input order is not guaranteed in Postgres, so leaving it out
     * would draw a sparkline whose points are in whatever sequence the planner
     * produced — still six numbers, still plausible, and wrong.
     */
    const name = uniqueName('series');
    const volumes = [3, 9, 4, 7, 5, 8];
    for (const [index, volume] of volumes.entries()) {
      const at = batchStamp(-(volumes.length - index) * 60_000);
      await svc.saveTrendingBatch([item({ name, volume, score: 50 })], at);
      if (index === volumes.length - 1) {
        await db.insert(trendBatches).values({ calculatedAt: at, summary: '' });
      }
    }

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === name);

    expect(trend?.series).toEqual(volumes);
  });

  it('keys the series on the NAME alone, so a provenance flip cannot cut a history in two', async () => {
    /**
     * `type` used to be part of the key, because a name could be measured twice
     * in one batch — once as a hashtag, once as a topic. Those lanes are gone: a
     * term is measured ONCE, and `type` is now provenance that can legitimately
     * flip between batches as the mix of posts spelling it with a `#` shifts.
     * Keying on the pair would cut one continuous history in two at the flip and
     * drop BOTH halves below the drawing floor — a sparkline that vanishes for a
     * trend that never stopped.
     */
    const name = uniqueName('flip');
    const volumes = [4, 5, 6, 7, 8, 9];
    for (const [index, volume] of volumes.entries()) {
      const at = batchStamp(-(volumes.length - index) * 60_000);
      // The provenance flips halfway through the run.
      const type = index < 3 ? 'hashtag' : 'topic';
      await svc.saveTrendingBatch([item({ name, type, volume, score: 50 })], at);
      if (index === volumes.length - 1) {
        await db.insert(trendBatches).values({ calculatedAt: at, summary: '' });
      }
    }

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === name);

    expect(trend?.series).toEqual(volumes);
  });

  it('omits the series entirely for a trend with too little history', async () => {
    // Absence is the honest answer and the client draws nothing. A padded or
    // flattened stand-in would be invented data.
    const name = uniqueName('short');
    const at = batchStamp();
    await svc.saveTrendingBatch([item({ name })], at);
    await db.insert(trendBatches).values({ calculatedAt: at, summary: '' });

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === name);

    expect(trend).toBeDefined();
    expect(trend).not.toHaveProperty('series');
  });
});

/**
 * A trend is not language-neutral — `noticia` is a Spanish story and reading it
 * in an Italian list is noise — so the reader's languages decide the ORDER.
 *
 * They must never decide MEMBERSHIP. A reader whose languages are quiet would
 * otherwise be served an empty widget, which is a worse answer than a list they
 * can partly read; the overfetch-then-reorder shape is what buys that.
 */
describe('getTrending — the reader\'s language orders, never filters', () => {
  async function publishLanguageBatch(): Promise<{ es: string; it: string; none: string }> {
    const es = uniqueName('es-trend');
    const it = uniqueName('it-trend');
    const none = uniqueName('no-lang-trend');
    const at = batchStamp();
    await svc.saveTrendingBatch(
      [
        item({ name: it, score: 30, languages: ['it'] }),
        item({ name: none, score: 20, languages: [] }),
        item({ name: es, score: 10, languages: ['es'] }),
      ],
      at,
    );
    await db.insert(trendBatches).values({ calculatedAt: at, summary: '' });
    return { es, it, none };
  }

  /** This batch's trends only, in served order — sibling rows can never match. */
  function ordered(trends: Array<{ name: string }>, names: string[]): string[] {
    return trends.map((trend) => trend.name).filter((name) => names.includes(name));
  }

  it('puts the trends a reader can read ahead of the ones they cannot', async () => {
    const { es, it, none } = await publishLanguageBatch();

    const result = await trendingService.getTrending(500, undefined, ['es']);

    // `it` scored HIGHEST and is now last: the reorder beat the score, which is
    // the whole assertion. A trend with NO recorded language is readable by
    // everyone — it predates trending measuring language — so it stays in the
    // leading group, and within a group the score order survives.
    expect(ordered(result.trending, [es, it, none])).toEqual([none, es, it]);
  });

  it('still returns the rest — a quiet language is never an empty widget', async () => {
    const { es, it, none } = await publishLanguageBatch();

    const result = await trendingService.getTrending(500, undefined, ['ja']);

    expect(ordered(result.trending, [es, it, none]).sort()).toEqual([es, it, none].sort());
  });

  it('leaves the order alone when the reader offers no language', async () => {
    const { es, it, none } = await publishLanguageBatch();

    const result = await trendingService.getTrending(500);

    // Score order, untouched.
    expect(ordered(result.trending, [es, it, none])).toEqual([it, none, es]);
  });
});

describe('getTrendingHistory — one row per (day, name, type)', () => {
  it("collapses a day's batches to the highest score per trend", async () => {
    const name = uniqueName('archived');
    const first = batchStamp(-120_000);
    const second = batchStamp(-60_000);

    await svc.saveTrendingBatch([item({ name, score: 10, volume: 1 })], first);
    await svc.saveTrendingBatch([item({ name, score: 40, volume: 4 })], second);

    const history = await trendingService.getTrendingHistory(1, 20);
    const mine = history.days.flatMap((day) => day.trends).filter((trend) => trend.name === name);

    expect(mine).toHaveLength(1);
    expect(mine[0].score).toBe(40);
    expect(mine[0].volume).toBe(4);
    // The wire shape matches `getTrending`'s exactly.
    expect(mine[0].calculatedAt).toBeInstanceOf(Date);
    expect(mine[0]).not.toHaveProperty('topicId');
    expect(mine[0]).not.toHaveProperty('__v');
  });

  it('cuts a day to a DETERMINISTIC top 20 when scores tie', async () => {
    /**
     * The truncation needs a strict total order or the same request answers
     * differently twice — the archive equivalent of a page that duplicates and
     * skips rows. Twenty-one trends, all on the same score: `score desc, id desc`
     * is what decides which twenty survive, and `id` is the only part of that
     * which can break the tie. Without it the surviving set is whatever the
     * planner happened to emit.
     */
    const marker = uniqueName('tied');
    const at = batchStamp();
    const names = Array.from({ length: 21 }, (_, index) => `${marker}-${index}`);
    await svc.saveTrendingBatch(names.map((name) => item({ name, score: 5 })), at);

    const stored = await db.select().from(trending).where(eq(trending.calculatedAt, at));
    const expected = stored
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, 20)
      .map((row) => row.name);

    const history = await trendingService.getTrendingHistory(1, 20);
    const returned = history.days
      .flatMap((day) => day.trends)
      .filter((trend) => trend.name.startsWith(marker))
      .map((trend) => trend.name);

    expect(returned).toHaveLength(20);
    expect(returned).toEqual(expected);
  });

  it('keeps a hashtag and a topic of the same name as two archived trends', async () => {
    const name = uniqueName('archived-both');
    const at = batchStamp();
    await svc.saveTrendingBatch(
      [item({ name, score: 30 }), item({ name, type: 'topic', score: 20 })],
      at,
    );

    const history = await trendingService.getTrendingHistory(1, 20);
    const mine = history.days.flatMap((day) => day.trends).filter((trend) => trend.name === name);

    expect(mine.map((trend) => trend.type).sort()).toEqual(['hashtag', 'topic']);
  });
});

describe('calculateTrending — end to end', () => {
  it('publishes the batch only after its rows exist, and broadcasts', async () => {
    /**
     * The ordering that the frozen-endpoint incident turned on: `trend_batches`
     * is what `getTrending` reads its timestamp from, so it must be written after
     * the rows it points at. A batch row pointing at nothing blanks the widget.
     */
    const tag = uniqueName('e2e');
    mocks.resolveNames.mockResolvedValue(new Map());
    mocks.updatePopularityFromTrending.mockResolvedValue(undefined);

    /**
     * The detection floors, satisfied as DATA rather than stubbed: `minVolume`
     * posts by `minAuthors`-or-more distinct authors, all inside the recent
     * window so the burst statistic clears `minBurstScore`.
     *
     * The filler is the share-of-corpus ceiling (`maxDocumentFrequency`). Five
     * posts in a corpus of five is 100% of the window, which is how a term
     * proves it is VOCABULARY rather than a subject — so the term needs a
     * network around it to be a trend at all. Sibling suites' rows only enlarge
     * the denominator further, which is the safe direction.
     */
    const authors = MtnConfig.trending.detection.minAuthors + 2;
    for (let i = 0; i < authors; i += 1) await seedPost([tag], `${tag}-author-${i}`);
    for (let i = 0; i < 4 * authors; i += 1) await seedPost([uniqueName('filler')]);

    await trendingService.calculateTrending();

    const [batch] = await db
      .select()
      .from(trendBatches)
      .orderBy(asc(trendBatches.calculatedAt))
      .limit(1);
    expect(batch).toBeDefined();
    createdBatchStamps.push(batch.calculatedAt);

    const result = await trendingService.getTrending(500);
    const trend = result.trending.find((row) => row.name === tag);
    expect(trend?.volume).toBe(authors);
    expect(mocks.emitTrendsUpdated).toHaveBeenCalledTimes(1);

    // The memoized current-batch token comes from the same row.
    expect(await trendingService.getCurrentRecId()).toEqual(expect.any(String));
  });
});

describe('cleanupOldTrends', () => {
  it('removes trends AND their batch rows past the retention window, and keeps recent ones', async () => {
    const oldName = uniqueName('ancient');
    const freshName = uniqueName('fresh');
    const old = batchStamp(-100 * 24 * 60 * 60 * 1000);
    const fresh = batchStamp();

    await svc.saveTrendingBatch([item({ name: oldName })], old);
    await db.insert(trendBatches).values({ calculatedAt: old, summary: '' });
    await svc.saveTrendingBatch([item({ name: freshName })], fresh);
    await db.insert(trendBatches).values({ calculatedAt: fresh, summary: '' });

    await svc.cleanupOldTrends();

    const remaining = await db
      .select()
      .from(trending)
      .where(inArray(trending.calculatedAt, [old, fresh]));
    expect(remaining.map((row) => row.name)).toEqual([freshName]);

    const remainingBatches = await db
      .select()
      .from(trendBatches)
      .where(inArray(trendBatches.calculatedAt, [old, fresh]));
    expect(remainingBatches.map((row) => row.calculatedAt.getTime())).toEqual([fresh.getTime()]);
    // The sweep is bounded by the retention cutoff, not by "everything old".
    expect(await db.select().from(trending).where(lt(trending.calculatedAt, old))).toEqual([]);
  });
});
