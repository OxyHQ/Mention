// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it, vi } from 'vitest';
import { TrendingService } from '../../services/trending/TrendingService';
import type { DistributedLock } from '../../utils/redisLock';

/**
 * The scheduled recalculation reads the 48-hour window of `posts` several times,
 * disk-bound; two at once slowed the explore feed to its statement timeout. These
 * pin the guard: one run per task at a time, one per cluster via the lock.
 */

function serviceWith(lock: DistributedLock) {
  const service = new TrendingService(lock);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calculate = vi.spyOn(service, 'calculateTrending').mockImplementation(() => gate);
  return { service, calculate, finish: release };
}

describe('TrendingService.runScheduledCalculation', () => {
  it('skips when another task holds the lock', async () => {
    const lock: DistributedLock = { tryAcquire: async () => ({ status: 'held' }) };
    const { service, calculate } = serviceWith(lock);
    await service.runScheduledCalculation();
    expect(calculate).not.toHaveBeenCalled();
  });

  it('runs once for concurrent triggers on one task, then releases the lock', async () => {
    const release = vi.fn(async () => {});
    const tryAcquire = vi.fn(async () => ({ status: 'acquired' as const, release }));
    const { service, calculate, finish } = serviceWith({ tryAcquire });

    const first = service.runScheduledCalculation();
    const second = service.runScheduledCalculation();
    await vi.waitFor(() => expect(calculate).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('runs unguarded when Redis is unavailable (the lock fails open)', async () => {
    const { service, calculate, finish } = serviceWith({
      tryAcquire: async () => ({ status: 'unavailable' }),
    });
    const run = service.runScheduledCalculation();
    await vi.waitFor(() => expect(calculate).toHaveBeenCalledTimes(1));
    finish();
    await run;
  });
});
