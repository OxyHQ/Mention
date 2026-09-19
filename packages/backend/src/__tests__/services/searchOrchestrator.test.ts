/**
 * The orchestrator's contract: a lane that fails is reported as failing.
 *
 * This is the reason the overview exists as an orchestrator rather than a
 * handler with seven `await`s, and it is the half the route test cannot reach —
 * the route builds its own lanes, so a failing or hanging lane has to be
 * injected here.
 *
 * The defect being prevented is specific. On the client, `Promise.allSettled`
 * collapsed a rejected lane into an empty section, so an outage rendered as a
 * confident "no results". Moving the fan-out server-side is only an improvement
 * if the status survives, and "an empty array" is not a status.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runSearchOverview,
  type LaneDefinition,
} from '../../services/search/SearchOrchestrator';

function lane(overrides: Partial<LaneDefinition> & Pick<LaneDefinition, 'name'>): LaneDefinition {
  return {
    budgetMs: 1_000,
    run: async () => ({ items: ['a'], hasMore: false }),
    ...overrides,
  };
}

describe('runSearchOverview', () => {
  it('returns a TOTAL lane map even when told about no lanes at all', async () => {
    const body = await runSearchOverview('q', [], []);

    // A client must be able to read every key without checking it exists. A
    // lane nobody ran is `unavailable`, not absent.
    expect(Object.keys(body.lanes).sort()).toEqual([
      'feeds', 'hashtags', 'lists', 'posts', 'profiles', 'saved', 'starterPacks',
    ]);
    for (const value of Object.values(body.lanes)) {
      expect(value.status).toBe('unavailable');
      expect(value.items).toEqual([]);
    }
  });

  it('reports a THROWING lane as error, with the others still ok', async () => {
    const body = await runSearchOverview(
      'q',
      [
        lane({ name: 'hashtags' }),
        lane({ name: 'feeds', run: async () => { throw new Error('lane exploded'); } }),
      ],
      [],
    );

    expect(body.lanes.feeds.status).toBe('error');
    expect(body.lanes.feeds.items).toEqual([]);
    // The distinction the whole contract rests on: `error` is not `ok` with an
    // empty array. A client rendering "no results" for this would be lying.
    expect(body.lanes.hashtags.status).toBe('ok');
    expect(body.lanes.hashtags.items).toEqual(['a']);
    expect(body.degraded).toBe(true);
  });

  it('reports a lane that exceeds its budget as timeout, and does not wait for it', async () => {
    const started = Date.now();
    const body = await runSearchOverview(
      'q',
      [
        lane({ name: 'hashtags' }),
        lane({
          name: 'feeds',
          budgetMs: 20,
          // Never settles. The response must come back anyway — the budget is
          // the point, and `Promise.allSettled` over the raw lanes would hang
          // here forever.
          run: () => new Promise(() => { /* intentionally pending */ }),
        }),
      ],
      [],
    );

    expect(body.lanes.feeds.status).toBe('timeout');
    expect(body.lanes.hashtags.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a Postgres statement timeout as timeout, not as error', async () => {
    // `statement_timeout` arrives as a rejection carrying SQLSTATE 57014.
    // Without the mapping, the lane MOST likely to be slow is the one reported
    // as broken — and a timeout is worth retrying where an error is not.
    const canceled = Object.assign(new Error('canceling statement due to statement timeout'), {
      cause: { code: '57014' },
    });

    const body = await runSearchOverview(
      'q',
      [lane({ name: 'lists', run: async () => { throw canceled; } })],
      [],
    );

    expect(body.lanes.lists.status).toBe('timeout');
  });

  it('does not count a deliberately skipped lane as degraded', async () => {
    const body = await runSearchOverview(
      'q',
      [lane({ name: 'hashtags' }), lane({ name: 'feeds' }), lane({ name: 'lists' }),
       lane({ name: 'starterPacks' }), lane({ name: 'posts' }), lane({ name: 'saved' })],
      [{ name: 'profiles', status: 'skipped' }],
    );

    // `profiles` is always skipped today, so counting `skipped` would make
    // `degraded` true on every search and carry no information.
    expect(body.lanes.profiles.status).toBe('skipped');
    expect(body.degraded).toBe(false);
  });

  it('counts an unavailable lane as degraded, because the viewer is missing it', async () => {
    const body = await runSearchOverview(
      'q',
      [lane({ name: 'hashtags' })],
      [{ name: 'posts', status: 'unavailable' }],
    );

    expect(body.degraded).toBe(true);
  });

  it('runs lanes concurrently rather than in sequence', async () => {
    // The whole point of replacing the client fan-out is that the server does
    // it in parallel. Three 60ms lanes in sequence would be ~180ms.
    const slow = (name: LaneDefinition['name']): LaneDefinition =>
      lane({
        name,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { items: [name], hasMore: false };
        },
      });

    const started = Date.now();
    await runSearchOverview('q', [slow('hashtags'), slow('feeds'), slow('lists')], []);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('records how long each lane took, so a slow one is visible', async () => {
    const body = await runSearchOverview('q', [lane({ name: 'hashtags' })], []);
    expect(typeof body.lanes.hashtags.tookMs).toBe('number');
    expect(body.lanes.hashtags.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a lane cursor through, so the tab can continue rather than restart', async () => {
    const body = await runSearchOverview(
      'q',
      [lane({ name: 'hashtags', run: async () => ({ items: ['a'], hasMore: true, nextCursor: 'c1' }) })],
      [],
    );

    expect(body.lanes.hashtags.hasMore).toBe(true);
    expect(body.lanes.hashtags.nextCursor).toBe('c1');
  });

  it('logs a lane failure rather than swallowing it', async () => {
    // A per-lane status is for the client; an operator still needs the reason.
    const { logger } = await import('../../utils/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      await runSearchOverview(
        'q',
        [lane({ name: 'feeds', run: async () => { throw new Error('lane exploded'); } })],
        [],
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
