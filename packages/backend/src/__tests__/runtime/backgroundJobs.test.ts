import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  workers: vi.fn(),
  queuesStop: vi.fn(),
  engagement: vi.fn(),
  engagementStop: vi.fn(),
  moderation: vi.fn(),
  moderationStop: vi.fn(),
  leader: vi.fn(),
  leaderStop: vi.fn(),
}));
vi.mock('../../queue/workers', () => ({
  startWorkers: mocks.workers,
  shutdownQueues: mocks.queuesStop,
}));
vi.mock('../../services/EngagementOutboxDispatcher', () => ({
  engagementOutboxDispatcher: { start: mocks.engagement, stop: mocks.engagementStop },
}));
vi.mock('../../services/moderation/ModerationOutboxDispatcher', () => ({
  moderationOutboxDispatcher: { start: mocks.moderation, stop: mocks.moderationStop },
}));
vi.mock('../../services/LeaderElection', () => ({
  leaderElection: { start: mocks.leader, stop: mocks.leaderStop },
}));
vi.mock('../../runtime/schedulers', () => ({ startSchedulers: vi.fn(), stopSchedulers: vi.fn() }));

describe('background process lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });
  it('starts each consumer once and waits for boot before idempotent drain', async () => {
    let finish: (() => void) | undefined;
    mocks.leader.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const jobs = await import('../../runtime/backgroundJobs');
    const first = jobs.startBackgroundJobs(true);
    expect(jobs.startBackgroundJobs(true)).toBe(first);
    const stop = jobs.stopBackgroundJobs();
    expect(jobs.stopBackgroundJobs()).toBe(stop);
    expect(mocks.queuesStop).not.toHaveBeenCalled();
    if (!finish) throw new Error('Leadership bootstrap did not start');
    finish();
    await stop;
    for (const fn of Object.values(mocks)) expect(fn).toHaveBeenCalledTimes(1);
    await expect(jobs.startBackgroundJobs(true)).rejects.toThrow('stopping');
  });
  it('fails split startup on consumer failure and still drains partial resources', async () => {
    mocks.workers.mockImplementation(() => {
      throw new Error('queue unavailable');
    });
    const jobs = await import('../../runtime/backgroundJobs');
    await expect(jobs.startBackgroundJobs(true)).rejects.toThrow('queue unavailable');
    expect(mocks.engagement).not.toHaveBeenCalled();
    await jobs.stopBackgroundJobs();
    expect(mocks.queuesStop).toHaveBeenCalledOnce();
  });
  it('preserves combined-mode degraded startup', async () => {
    mocks.workers.mockImplementation(() => {
      throw new Error('queue unavailable');
    });
    const jobs = await import('../../runtime/backgroundJobs');
    await jobs.startBackgroundJobs(false);
    expect(mocks.engagement).toHaveBeenCalledOnce();
    expect(mocks.leader).toHaveBeenCalledOnce();
    await jobs.stopBackgroundJobs();
  });
});
