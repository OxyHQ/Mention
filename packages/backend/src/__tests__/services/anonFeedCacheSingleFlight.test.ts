import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/cache', () => ({
  createCache: () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) }),
}));

import { anonFeedCache } from '../../services/anonFeedCache';

/**
 * An expired anonymous page is missed by every request that arrives before the
 * first rebuild lands. `claimBuild` makes one of them the builder and hands the
 * rest its answer, so a burst costs one pipeline run per process, not one each.
 */
describe('anonFeedCache.claimBuild', () => {
  const page = { items: [], slices: [], hasMore: false, totalCount: 0 } as never;

  it('makes the first caller lead and later callers join its result', async () => {
    const lead = anonFeedCache.claimBuild('k1');
    const join = anonFeedCache.claimBuild('k1');
    expect(lead.role).toBe('lead');
    expect(join.role).toBe('join');

    if (lead.role !== 'lead' || join.role !== 'join') throw new Error('unreachable');
    lead.settle(page);
    await expect(join.result).resolves.toBe(page);
  });

  it('releases the key once settled, so the next miss leads again', () => {
    const first = anonFeedCache.claimBuild('k2');
    if (first.role !== 'lead') throw new Error('expected lead');
    first.settle(null);
    expect(anonFeedCache.claimBuild('k2').role).toBe('lead');
  });

  it('keeps the first answer when settled twice (the finally after a success)', async () => {
    const lead = anonFeedCache.claimBuild('k3');
    const join = anonFeedCache.claimBuild('k3');
    if (lead.role !== 'lead' || join.role !== 'join') throw new Error('unreachable');
    lead.settle(page);
    lead.settle(null);
    await expect(join.result).resolves.toBe(page);
  });

  it('keys are independent', () => {
    expect(anonFeedCache.claimBuild('a').role).toBe('lead');
    expect(anonFeedCache.claimBuild('b').role).toBe('lead');
  });
});
