/**
 * The schedule around `topic_affinity_posts`.
 *
 * What the view holds, and that topic affinity follows it on the next refresh,
 * is proven against real rows in `db/contentAffinityQueries.test.ts`. This file
 * holds what the job adds on top: a refresh never overlaps another and never
 * throws into the scheduler.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../db/postgres', () => ({ getDb: () => ({ execute: executeMock }) }));

import { TopicAffinityRefreshJob } from '../../services/TopicAffinityRefreshJob';

afterEach(() => {
  executeMock.mockReset();
});

describe('TopicAffinityRefreshJob.runRefresh', () => {
  it('refreshes the view concurrently, so readers keep the previous contents meanwhile', async () => {
    executeMock.mockResolvedValue([]);

    await expect(new TopicAffinityRefreshJob().runRefresh()).resolves.toBe(true);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const statement = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(statement).toContain('refresh materialized view concurrently topic_affinity_posts');
  });

  it('makes a tick that lands mid-refresh a no-op rather than a second refresh', async () => {
    let finish: (value: unknown) => void = () => {};
    executeMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const job = new TopicAffinityRefreshJob();

    const first = job.runRefresh();
    await expect(job.runRefresh()).resolves.toBe(false);
    finish([]);
    await expect(first).resolves.toBe(true);

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed refresh without throwing, and can refresh again afterwards', async () => {
    executeMock.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
    executeMock.mockResolvedValueOnce([]);
    const job = new TopicAffinityRefreshJob();

    await expect(job.runRefresh()).resolves.toBe(false);
    await expect(job.runRefresh()).resolves.toBe(true);
  });
});
