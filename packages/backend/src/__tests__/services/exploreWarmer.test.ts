import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistributedLock } from '../../utils/redisLock';

/**
 * The warm-up is the real Explore candidate read, run on a timer. A second copy
 * at the same time would only add load to the disk it exists to relieve, and a
 * failed read must not stop the timer.
 */

const source = vi.hoisted(() => ({ gather: vi.fn() }));

vi.mock('../../mtn/feed/engine/sources/discoverySources', () => ({
  exploreSource: { gather: source.gather },
}));

import { ExploreWarmer } from '../../services/feed/ExploreWarmer';

beforeEach(() => {
  source.gather.mockReset();
  source.gather.mockResolvedValue([]);
});

describe('ExploreWarmer.runOnce', () => {
  it('skips when another task holds the lock', async () => {
    const lock: DistributedLock = { tryAcquire: async () => ({ status: 'held' }) };
    await new ExploreWarmer(lock).runOnce();
    expect(source.gather).not.toHaveBeenCalled();
  });

  it('reads once for concurrent triggers on one task, as the anonymous reader, then releases the lock', async () => {
    let finish!: () => void;
    source.gather.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const release = vi.fn(async () => {});
    const tryAcquire = vi.fn(async () => ({ status: 'acquired' as const, release }));
    const warmer = new ExploreWarmer({ tryAcquire });

    const first = warmer.runOnce();
    const second = warmer.runOnce();
    await vi.waitFor(() => expect(source.gather).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(source.gather.mock.calls[0][0]).toMatchObject({ currentUserId: undefined });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('runs unguarded when Redis is unavailable (the lock fails open)', async () => {
    await new ExploreWarmer({ tryAcquire: async () => ({ status: 'unavailable' }) }).runOnce();
    expect(source.gather).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and can run again after a failed read', async () => {
    const release = vi.fn(async () => {});
    const warmer = new ExploreWarmer({
      tryAcquire: async () => ({ status: 'acquired', release }),
    });
    source.gather.mockRejectedValueOnce(new Error('statement timeout'));

    await expect(warmer.runOnce()).rejects.toThrow('statement timeout');
    await warmer.runOnce();

    expect(release).toHaveBeenCalledTimes(2);
    expect(source.gather).toHaveBeenCalledTimes(2);
  });
});
