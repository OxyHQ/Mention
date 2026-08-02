import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  findOne: vi.fn(),
  create: vi.fn(),
  aliaChat: vi.fn(),
  isAliaEnabled: vi.fn(() => true),
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  getRedisClient: vi.fn(),
}));

vi.mock('../models/TrendSummary', () => ({
  __esModule: true,
  default: { findOne: mocks.findOne, create: mocks.create, collection: {} },
  TREND_SUMMARY_TTL_SECONDS: 30 * 24 * 60 * 60,
}));
vi.mock('../utils/alia', () => ({
  aliaChat: (...args: unknown[]) => mocks.aliaChat(...args),
  isAliaEnabled: () => mocks.isAliaEnabled(),
}));
vi.mock('../utils/redis', () => ({ getRedisClient: () => mocks.getRedisClient() }));

const { resolveTrendSummary } = await import('../services/trending/trendSummary');
const { MtnConfig } = await import('@mention/shared-types');

const RUN_STARTED_AT = new Date('2026-08-01T00:00:00.000Z');
const POSTS = ['Orioles trading Dean Kremer', 'Kremer to the Twins', 'the trade is done'];

/** A query chain ending in `.lean()`. */
function leanChain(value: unknown) {
  return { lean: () => Promise.resolve(value) };
}

function call(loadExcerpts = () => Promise.resolve(POSTS)) {
  return resolveTrendSummary({ term: 'orioles', runStartedAt: RUN_STARTED_AT, loadExcerpts });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAliaEnabled.mockReturnValue(true);
  mocks.findOne.mockReturnValue(leanChain(null));
  mocks.create.mockResolvedValue({});
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
    mocks.findOne.mockReturnValue(leanChain({ description: 'already written' }));

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
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('sets the counter TTL once, on the first view only', async () => {
    mocks.incr.mockResolvedValue(1);
    await call();
    expect(mocks.expire).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.findOne.mockReturnValue(leanChain(null));
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
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reads the winner of a race rather than reporting the duplicate as an error', async () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mocks.create.mockRejectedValue(duplicate);
    mocks.findOne
      .mockReturnValueOnce(leanChain(null))
      .mockReturnValueOnce(leanChain({ description: 'written by the other task' }));

    expect(await call()).toEqual({ description: 'written by the other task' });
  });

  it('answers empty when the stored lookup itself fails', async () => {
    mocks.findOne.mockImplementation(() => {
      throw new Error('mongo down');
    });
    expect(await call()).toEqual({});
  });
});

describe('resolveTrendSummary — what gets stored', () => {
  it('stores the summary under the term AND the run', async () => {
    await call();

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ term: 'orioles', runStartedAt: RUN_STARTED_AT }),
    );
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
      term: '  ORIOLES ',
      runStartedAt: RUN_STARTED_AT,
      loadExcerpts: () => Promise.resolve(POSTS),
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ term: 'orioles' }));
  });
});
