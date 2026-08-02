import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * On-demand trend summaries — the ONE place this feature can spend money.
 *
 * Everything asserted here is a spend bound. The interesting failures are all in
 * the direction of paying for something: generating below the threshold,
 * generating twice for one run, generating when the demand signal cannot be
 * measured, or generating with nothing to read. Each has its own test, because a
 * single "it works" test would pass while any one of them regressed.
 */

const mocks = vi.hoisted(() => ({
  aliaChat: vi.fn(),
  isAliaEnabled: vi.fn(() => true),
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  getRedisClient: vi.fn(),
}));

vi.mock('../utils/alia', () => ({
  aliaChat: (...args: unknown[]) => mocks.aliaChat(...args),
  isAliaEnabled: () => mocks.isAliaEnabled(),
}));
vi.mock('../utils/redis', () => ({ getRedisClient: () => mocks.getRedisClient() }));

const { and, eq } = await import('drizzle-orm');
const { closePostgres, connectPostgres, getDb } = await import('../db/postgres');
const { trendSummaries } = await import('../db/schema/discovery');
const { resolveTrendSummary } = await import('../services/trending/trendSummary');
const { MtnConfig } = await import('@mention/shared-types');

const RUN_STARTED_AT = new Date('2026-08-01T00:00:00.000Z');
const POSTS = ['Orioles trading Dean Kremer', 'Kremer to the Twins', 'the trade is done'];

/**
 * The term, namespaced per run. `trend_summaries` is keyed `(term,
 * run_started_at)` and vitest runs files in parallel against one database, so a
 * bare `orioles` would be a claim about every other file — and the stored-answer
 * case would start passing or failing on what somebody else wrote.
 */
const TERM = `orioles-${randomUUID().slice(0, 8)}`;

/** The stored summary for this run, read straight from the table. */
async function storedSummary(): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ description: trendSummaries.description })
    .from(trendSummaries)
    .where(and(eq(trendSummaries.term, TERM), eq(trendSummaries.runStartedAt, RUN_STARTED_AT)));
  return row?.description;
}

async function store(description: string): Promise<void> {
  await getDb()
    .insert(trendSummaries)
    .values({ term: TERM, runStartedAt: RUN_STARTED_AT, description, generatedAt: new Date() });
}

function call(loadExcerpts = () => Promise.resolve(POSTS)) {
  return resolveTrendSummary({ term: TERM, runStartedAt: RUN_STARTED_AT, loadExcerpts });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await getDb().delete(trendSummaries).where(eq(trendSummaries.term, TERM));
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(trendSummaries).where(eq(trendSummaries.term, TERM));
  mocks.isAliaEnabled.mockReturnValue(true);
  mocks.aliaChat.mockResolvedValue('The Orioles traded Dean Kremer to the Twins.');
  mocks.incr.mockResolvedValue(MtnConfig.trending.summary.minViews);
  mocks.expire.mockResolvedValue(1);
  mocks.set.mockResolvedValue('OK');
  mocks.getRedisClient.mockResolvedValue({
    incr: mocks.incr,
    expire: mocks.expire,
    set: mocks.set,
  });
});

describe('resolveTrendSummary — the stored answer wins', () => {
  it('serves an existing summary without counting or generating', async () => {
    await store('already written');

    expect(await call()).toEqual({ description: 'already written' });
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });
});

describe('resolveTrendSummary — demand pays for it', () => {
  it('does not generate below the view threshold', async () => {
    mocks.incr.mockResolvedValue(MtnConfig.trending.summary.minViews - 1);

    expect(await call()).toEqual({});
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });

  it('generates exactly when the threshold is reached', async () => {
    mocks.incr.mockResolvedValue(MtnConfig.trending.summary.minViews);

    expect((await call()).description).toBe('The Orioles traded Dean Kremer to the Twins.');
    expect(mocks.aliaChat).toHaveBeenCalledOnce();
    // Stored, not merely returned: the next reader must get it without paying
    // for a second generation.
    expect(await storedSummary()).toBe('The Orioles traded Dean Kremer to the Twins.');
  });

  it('sets the counter TTL once, on the first view only', async () => {
    mocks.incr.mockResolvedValue(1);
    await call();
    expect(mocks.expire).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    await getDb().delete(trendSummaries).where(eq(trendSummaries.term, TERM));
    mocks.incr.mockResolvedValue(2);
    mocks.getRedisClient.mockResolvedValue({ incr: mocks.incr, expire: mocks.expire, set: mocks.set });
    mocks.isAliaEnabled.mockReturnValue(true);
    await call();
    expect(mocks.expire).not.toHaveBeenCalled();
  });
});

describe('resolveTrendSummary — refuses to spend when it cannot justify it', () => {
  it('never calls the model when no key is configured', async () => {
    mocks.isAliaEnabled.mockReturnValue(false);

    expect(await call()).toEqual({});
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });

  it('never generates when demand cannot be counted at all', async () => {
    // No Redis means no demand signal, and an uncountable open demonstrates
    // nothing — failing the other way would generate for every trend opened
    // during an outage.
    mocks.getRedisClient.mockResolvedValue(null);

    expect(await call()).toEqual({});
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });

  it('never generates when another task holds the lock', async () => {
    mocks.set.mockResolvedValue(null);

    expect(await call()).toEqual({});
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });

  it('never generates with nothing to read', async () => {
    // Explaining a trend from its term alone is how a summary becomes fiction.
    expect(await call(() => Promise.resolve([]))).toEqual({});
    expect(mocks.aliaChat).not.toHaveBeenCalled();
  });
});

describe('resolveTrendSummary — failure is invisible to the reader', () => {
  it('answers empty when the model throws', async () => {
    mocks.aliaChat.mockRejectedValue(new Error('upstream down'));
    expect(await call()).toEqual({});
  });

  it('answers empty when the model returns nothing usable', async () => {
    mocks.aliaChat.mockResolvedValue('   ');
    expect(await call()).toEqual({});
    expect(await storedSummary()).toBeUndefined();
  });

  it('reads the winner of a race rather than reporting the duplicate as an error', async () => {
    /**
     * The race, STAGED rather than simulated: the competing row is written from
     * inside `loadExcerpts`, which runs after this call's own "is one stored?"
     * read and before its insert. So the insert really does raise `23505`
     * against the real unique constraint, which is the whole mechanism —
     * `(term, run_started_at)` is what makes one generation per run true by
     * construction rather than by remembering to check.
     */
    const result = await call(async () => {
      await store('written by the other task');
      return POSTS;
    });

    expect(result).toEqual({ description: 'written by the other task' });
    // The loser did not overwrite the winner.
    expect(await storedSummary()).toBe('written by the other task');
  });
});

describe('resolveTrendSummary — what gets stored', () => {
  it('stores the summary under the term AND the run', async () => {
    await call();

    const rows = await getDb()
      .select()
      .from(trendSummaries)
      .where(eq(trendSummaries.term, TERM));
    expect(rows).toHaveLength(1);
    expect(rows[0].runStartedAt).toEqual(RUN_STARTED_AT);
    // A run is part of the IDENTITY, not metadata: `orioles` is a trade this
    // week and a no-hitter next month, and a summary written for one would be
    // actively wrong for the other.
    const otherRun = new Date(RUN_STARTED_AT.getTime() + 86_400_000);
    expect(
      await resolveTrendSummary({
        term: TERM,
        runStartedAt: otherRun,
        loadExcerpts: () => Promise.resolve(POSTS),
      }),
    ).toEqual({ description: 'The Orioles traded Dean Kremer to the Twins.' });
    expect(await getDb().select().from(trendSummaries).where(eq(trendSummaries.term, TERM)))
      .toHaveLength(2);
  });

  it('truncates a runaway answer to the configured length', async () => {
    mocks.aliaChat.mockResolvedValue('x'.repeat(MtnConfig.trending.summary.maxLength + 500));

    const { description } = await call();
    expect(description).toHaveLength(MtnConfig.trending.summary.maxLength);
  });

  it('normalizes whitespace so a stored summary is one clean paragraph', async () => {
    mocks.aliaChat.mockResolvedValue('  The Orioles\n\n traded   Kremer.  ');
    expect((await call()).description).toBe('The Orioles traded Kremer.');
  });

  it('lowercases the term it stores under, so one run has one key', async () => {
    await resolveTrendSummary({
      term: `  ${TERM.toUpperCase()} `,
      runStartedAt: RUN_STARTED_AT,
      loadExcerpts: () => Promise.resolve(POSTS),
    });
    // Stored under the NORMALIZED term, so one run has one key however the
    // reader spelled it.
    expect(await storedSummary()).toBe('The Orioles traded Dean Kremer to the Twins.');
  });
});
