import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline tests for the federated-banner backfill.
 *
 * `connectToDatabase`/`mongoose.disconnect`, `FederatedActor`, `UserSettings`,
 * and `mirrorFederatedBanner` are mocked so the REAL paging, idempotent skip,
 * global rate gate, transient-retry/backoff, and permanent-`dead` classification
 * run WITHOUT MongoDB or a network. Mirrors the in-package pattern from
 * `scripts/backfillMtnRecords.test.ts`.
 *
 * Fake timers keep the rate-gate spacing (≥ 60000/rate ms between upload starts)
 * and the exponential backoff (2s/6s) instant while still asserting the gate is a
 * REAL cap: each `acquire()` and each `sleep()` is advanced deterministically.
 */

interface ActorRow {
  _id: mongoose.Types.ObjectId;
  uri: string;
  headerUrl: string;
  oxyUserId: string;
}

const h = vi.hoisted(() => {
  const state: {
    actors: ActorRow[];
    // oxyUserIds whose UserSettings.profileHeaderImage is already set.
    alreadySet: Set<string>;
    // queued mirror results, consumed FIFO per call (keyed by oxyUserId).
    mirrorResults: Map<string, Array<{ ok: boolean; permanent: boolean } | Error>>;
  } = { actors: [], alreadySet: new Set(), mirrorResults: new Map() };

  // FederatedActor.find — first cursor read returns the candidate page, a query
  // carrying a `$gt` cursor clause returns empty so the paging loop terminates.
  const actorFind = vi.fn((query: { _id?: { $gt?: unknown } }) => ({
    sort: () => ({
      limit: () => ({
        lean: async () => (query._id?.$gt ? [] : state.actors),
      }),
    }),
  }));

  const actorCount = vi.fn(async () => state.actors.length);

  const settingsFindOne = vi.fn((query: { oxyUserId: string }) => ({
    lean: async () =>
      state.alreadySet.has(query.oxyUserId) ? { profileHeaderImage: 'existing_file' } : null,
  }));

  const mirror = vi.fn(async (_url: string, oxyUserId: string) => {
    const queue = state.mirrorResults.get(oxyUserId);
    const next = queue?.shift();
    if (next instanceof Error) throw next;
    return next ?? { ok: true, permanent: false };
  });

  return { state, actorFind, actorCount, settingsFindOne, mirror };
});

vi.mock('../../utils/database', () => ({
  connectToDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: {
    find: h.actorFind,
    countDocuments: h.actorCount,
  },
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    findOne: h.settingsFindOne,
  },
}));

vi.mock('../../connectors/identity', () => ({
  mirrorFederatedBanner: h.mirror,
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    default: { ...actual.default, disconnect: vi.fn(async () => undefined) },
  };
});

import backfillFederatedBanners from '../../scripts/backfillFederatedBanners';

function actor(oxyUserId: string): ActorRow {
  return {
    _id: new mongoose.Types.ObjectId(),
    uri: `https://mastodon.social/users/${oxyUserId}`,
    headerUrl: `https://files.mastodon.social/${oxyUserId}.png`,
    oxyUserId,
  };
}

/**
 * Run the backfill under fake timers, draining every pending timer (the rate-gate
 * spacing + backoff sleeps) so the async chain completes deterministically.
 */
async function runBackfill(): Promise<void> {
  const done = backfillFederatedBanners();
  await vi.runAllTimersAsync();
  await done;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.state.actors = [];
  h.state.alreadySet = new Set();
  h.state.mirrorResults = new Map();
  delete process.env.BACKFILL_FORCE;
  delete process.env.BACKFILL_CONCURRENCY;
  delete process.env.BACKFILL_RATE_PER_MIN;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock('../../scripts/backfillFederatedBanners');
});

describe('backfillFederatedBanners', () => {
  it('mirrors every un-set actor banner and stores it', async () => {
    h.state.actors = [actor('u1'), actor('u2'), actor('u3')];

    await runBackfill();

    expect(h.mirror).toHaveBeenCalledTimes(3);
    expect(h.mirror).toHaveBeenCalledWith(
      'https://files.mastodon.social/u1.png',
      'u1',
      'https://mastodon.social/users/u1',
    );
  });

  it('skips actors whose profile header image is already set (idempotent)', async () => {
    h.state.actors = [actor('u1'), actor('u2')];
    h.state.alreadySet.add('u1');

    await runBackfill();

    // u1 is skipped → only u2 is mirrored.
    expect(h.mirror).toHaveBeenCalledTimes(1);
    expect(h.mirror).toHaveBeenCalledWith(
      'https://files.mastodon.social/u2.png',
      'u2',
      'https://mastodon.social/users/u2',
    );
  });

  it('re-mirrors already-set actors under BACKFILL_FORCE', async () => {
    // FORCE is read at module-load time, so re-import the script with the env var
    // set to exercise the force path (the top-level mocks are preserved by
    // re-registering them after the reset).
    process.env.BACKFILL_FORCE = 'true';
    h.state.actors = [actor('u1')];
    h.state.alreadySet.add('u1');

    vi.resetModules();
    vi.doMock('../../utils/database', () => ({ connectToDatabase: vi.fn(async () => undefined) }));
    vi.doMock('../../models/FederatedActor', () => ({
      FederatedActor: { find: h.actorFind, countDocuments: h.actorCount },
    }));
    vi.doMock('../../models/UserSettings', () => ({ default: { findOne: h.settingsFindOne } }));
    vi.doMock('../../connectors/identity', () => ({ mirrorFederatedBanner: h.mirror }));
    vi.doMock('../../utils/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('mongoose', async () => {
      const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
      return { ...actual, default: { ...actual.default, disconnect: vi.fn(async () => undefined) } };
    });

    const forced = (await import('../../scripts/backfillFederatedBanners')).default;
    const done = forced();
    await vi.runAllTimersAsync();
    await done;

    // FORCE bypasses the idempotent skip — the already-set actor is re-mirrored.
    expect(h.settingsFindOne).not.toHaveBeenCalled();
    expect(h.mirror).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    h.state.actors = [actor('u1')];
    h.state.mirrorResults.set('u1', [
      { ok: false, permanent: false },
      { ok: false, permanent: false },
      { ok: true, permanent: false },
    ]);

    await runBackfill();

    // 3 attempts total (2 transient + 1 success) — each re-passed the rate gate.
    expect(h.mirror).toHaveBeenCalledTimes(3);
  });

  it('counts a failure after exhausting all retry attempts', async () => {
    h.state.actors = [actor('u1')];
    h.state.mirrorResults.set('u1', [
      { ok: false, permanent: false },
      { ok: false, permanent: false },
      { ok: false, permanent: false },
    ]);

    await runBackfill();

    // MAX_ATTEMPTS = 3 → exactly 3 calls, no infinite retry.
    expect(h.mirror).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent failure', async () => {
    h.state.actors = [actor('u1')];
    h.state.mirrorResults.set('u1', [{ ok: false, permanent: true }]);

    await runBackfill();

    expect(h.mirror).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown error as transient, then succeeds', async () => {
    h.state.actors = [actor('u1')];
    h.state.mirrorResults.set('u1', [new Error('network blip'), { ok: true, permanent: false }]);

    await runBackfill();

    expect(h.mirror).toHaveBeenCalledTimes(2);
  });

  it('spaces upload starts by the rate-gate minimum interval (real cap)', async () => {
    process.env.BACKFILL_RATE_PER_MIN = '30'; // 60000/30 = 2000ms between starts
    process.env.BACKFILL_CONCURRENCY = '4'; // concurrency must NOT defeat the gate
    h.state.actors = [actor('u1'), actor('u2'), actor('u3')];

    const startTimes: number[] = [];
    h.mirror.mockImplementation(async () => {
      startTimes.push(Date.now());
      return { ok: true, permanent: false };
    });

    await runBackfill();

    expect(startTimes).toHaveLength(3);
    // Despite concurrency 4, starts are ≥ 2000ms apart (the gate serializes them).
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(2000);
    expect(startTimes[2] - startTimes[1]).toBeGreaterThanOrEqual(2000);
  });
});
