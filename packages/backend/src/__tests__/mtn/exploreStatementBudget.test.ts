import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Explore's candidate query scores a day of posts and takes 4 to 25 s depending on
 * what is cached; the serving pool's 15 s statement timeout killed it every time
 * it was cold, so no page was ever built or cached. It must run under its own,
 * larger budget (and under the load balancer's 60 s idle timeout).
 */

const budget = vi.hoisted(() => ({ calls: [] as number[] }));

vi.mock('../../utils/withStatementTimeout', () => ({
  withStatementTimeout: vi.fn(async (ms: number) => {
    budget.calls.push(ms);
    throw new Error('stop after the budget is taken');
  }),
}));

import { exploreSource } from '../../mtn/feed/engine/sources/discoverySources';

beforeEach(() => {
  budget.calls.length = 0;
});

describe('exploreSource.gather statement budget', () => {
  it('runs the candidate query under a budget above the serving 15 s and below the 60 s balancer idle timeout', async () => {
    await expect(
      exploreSource.gather({ currentUserId: undefined } as never, {}, 20),
    ).rejects.toThrow('stop after the budget is taken');

    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]).toBeGreaterThan(15_000);
    expect(budget.calls[0]).toBeLessThan(60_000);
  });
});
