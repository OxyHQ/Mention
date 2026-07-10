import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CachedUserSummary } from '../services/userSummaryCache';

/**
 * Unit tests for the leader-gated follower-snapshot job.
 *
 * Verifies (1) the sweep samples active authors' follower counts and appends one
 * snapshot per author with a numeric count, and (2) scheduling is gated: the
 * timers are deferred + only armed when `REDIS_URL` is set (no Redis → inline
 * no-op), and timers are unref'd so the job never keeps the loop alive.
 */

let distinctResult: unknown[] = [];
let summaries = new Map<string, CachedUserSummary>();

const distinct = vi.fn((_field: string, _filter: unknown) => Promise.resolve(distinctResult));
const insertMany = vi.fn((_docs: unknown[], _opts: unknown) => Promise.resolve([]));
const resolveUserSummaries = vi.fn((_ids: string[]) => Promise.resolve(summaries));

vi.mock('../models/Post', () => ({
  Post: { distinct: (field: string, filter: unknown) => distinct(field, filter) },
}));

vi.mock('../models/AuthorFollowerSnapshot', () => ({
  AuthorFollowerSnapshot: { insertMany: (docs: unknown[], opts: unknown) => insertMany(docs, opts) },
}));

vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: (ids: string[]) => resolveUserSummaries(ids),
}));

import {
  FollowerSnapshotJob,
  followerSnapshotJob,
  FOLLOWER_SNAPSHOT_START_DELAY_MS,
} from '../services/followerSnapshotJob';

function summary(followerCount?: number): CachedUserSummary {
  return {
    user: { id: 'x', username: 'x', name: {} },
    followerCount,
  };
}

beforeEach(() => {
  distinctResult = [];
  summaries = new Map();
  vi.clearAllMocks();
});

afterEach(() => {
  followerSnapshotJob.stop();
  delete process.env.REDIS_URL;
});

describe('runSnapshotSweep', () => {
  it('appends one snapshot per active author that reports a numeric follower count', async () => {
    distinctResult = ['A', 'B', 'C'];
    summaries = new Map([
      ['A', summary(100)],
      ['B', summary(50)],
      ['C', summary(undefined)], // no follower count → skipped
    ]);

    await followerSnapshotJob.runSnapshotSweep();

    expect(distinct).toHaveBeenCalledTimes(1);
    expect(resolveUserSummaries).toHaveBeenCalledWith(['A', 'B', 'C']);
    expect(insertMany).toHaveBeenCalledTimes(1);
    const [docs] = insertMany.mock.calls[0];
    expect(docs).toHaveLength(2);
    const byId = new Map((docs as Array<{ oxyUserId: string; followerCount: number; at: Date }>).map((d) => [d.oxyUserId, d]));
    expect(byId.get('A')?.followerCount).toBe(100);
    expect(byId.get('B')?.followerCount).toBe(50);
    expect(byId.get('A')?.at).toBeInstanceOf(Date);
    expect(byId.has('C')).toBe(false);
  });

  it('does not insert when there are no active authors', async () => {
    distinctResult = [];
    await followerSnapshotJob.runSnapshotSweep();
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('does not insert when no author reports a follower count', async () => {
    distinctResult = ['A'];
    summaries = new Map([['A', summary(undefined)]]);
    await followerSnapshotJob.runSnapshotSweep();
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('never throws — a failing query is swallowed', async () => {
    distinct.mockRejectedValueOnce(new Error('db down'));
    await expect(followerSnapshotJob.runSnapshotSweep()).resolves.toBeUndefined();
    expect(insertMany).not.toHaveBeenCalled();
  });
});

describe('start() scheduling gate', () => {
  it('is an inline no-op when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    vi.useFakeTimers();
    const job = new FollowerSnapshotJob();
    const spy = vi.spyOn(job, 'runSnapshotSweep').mockResolvedValue();
    job.start();
    vi.advanceTimersByTime(FOLLOWER_SNAPSHOT_START_DELAY_MS + 1000);
    expect(spy).not.toHaveBeenCalled();
    job.stop();
    vi.useRealTimers();
  });

  it('defers the first sweep and arms it after the start delay when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    vi.useFakeTimers();
    const job = new FollowerSnapshotJob();
    const spy = vi.spyOn(job, 'runSnapshotSweep').mockResolvedValue();
    job.start();
    expect(spy).not.toHaveBeenCalled(); // deferred, not immediate
    vi.advanceTimersByTime(FOLLOWER_SNAPSHOT_START_DELAY_MS + 1);
    expect(spy).toHaveBeenCalledTimes(1);
    job.stop();
    vi.useRealTimers();
  });
});
