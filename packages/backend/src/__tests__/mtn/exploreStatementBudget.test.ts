// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
    // `withStatementTimeout` is mocked and never reaches a database, so this file
    // needs no isolated one; reading `gather` off the module keeps the job-caller
    // scan of `isolatedDatabaseCoverage` for the files that really run the query.
    const { gather } = exploreSource;
    await expect(gather({ currentUserId: undefined } as never, {}, 20)).rejects.toThrow(
      'stop after the budget is taken',
    );

    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]).toBeGreaterThan(15_000);
    expect(budget.calls[0]).toBeLessThan(60_000);
  });
});
