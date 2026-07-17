import { describe, expect, it } from 'vitest';

import {
  mapWithConcurrency,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from '../../scripts/mapWithConcurrency';

/**
 * The bounded-concurrency pool that both one-shot repair sweeps
 * (`reingestBlueskyPosts`, `pruneGoneFederatedActors`) run their per-page work
 * through. The properties that matter for a live prod sweep:
 *
 *  - it never runs more than `concurrency` workers at once (that cap is the only
 *    thing keeping the sweep from hammering oxy-api / the remote servers);
 *  - every item is processed exactly once, and the results stay index-aligned
 *    with the input (the scan tallies counters off `results[i]`);
 *  - a single throwing worker surfaces as THAT item's failure and never aborts
 *    the batch (one bad post/actor must not sink the whole page);
 *  - combined with the caller pre-slicing each page to the remaining `--limit`,
 *    the pool processes exactly the items handed to it — no overshoot.
 */

/** A deferred that lets a test hold a worker "in flight" until it chooses to release it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency cap and processes every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const CONCURRENCY = 4;

    let inFlight = 0;
    let peak = 0;
    const startCount = new Map<number, number>();

    const results = await mapWithConcurrency(items, CONCURRENCY, async (item) => {
      startCount.set(item, (startCount.get(item) ?? 0) + 1);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield across a microtask boundary so overlapping workers actually overlap.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return item * 2;
    });

    // Cap respected: at no point were more than CONCURRENCY workers in flight.
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(peak).toBe(CONCURRENCY); // ...and the pool actually saturated.

    // Every item processed exactly once.
    expect(startCount.size).toBe(items.length);
    for (const item of items) expect(startCount.get(item)).toBe(1);

    // Results are index-aligned with the input.
    expect(results).toHaveLength(items.length);
    for (let i = 0; i < items.length; i++) {
      const settled = results[i];
      expect(settled.status).toBe('fulfilled');
      if (settled.status === 'fulfilled') expect(settled.value).toBe(items[i] * 2);
    }
  });

  it('holds the pool at exactly `concurrency` in flight until slots free up', async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let started = 0;

    const run = mapWithConcurrency(gates, 2, async (gate) => {
      started += 1;
      await gate.promise;
      return 'ok' as const;
    });

    // Two workers should be running; the other two blocked behind the cap.
    await Promise.resolve();
    expect(started).toBe(2);

    // Releasing one in-flight worker frees exactly one slot.
    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    const results = await run;
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(started).toBe(4);
  });

  it('surfaces a per-item rejection as that item’s failure without aborting the batch', async () => {
    const items = [0, 1, 2, 3, 4];
    const boom = new Error('item 2 blew up');

    const results = await mapWithConcurrency(items, 3, async (item) => {
      if (item === 2) throw boom;
      return item;
    });

    expect(results).toHaveLength(items.length);
    for (const item of items) {
      const settled = results[item];
      if (item === 2) {
        expect(settled.status).toBe('rejected');
        if (settled.status === 'rejected') expect(settled.reason).toBe(boom);
      } else {
        expect(settled.status).toBe('fulfilled');
        if (settled.status === 'fulfilled') expect(settled.value).toBe(item);
      }
    }
  });

  it('processes exactly the items it is given — the caller pre-slices to the --limit budget', async () => {
    // The scan loop slices each page to `min(PAGE_SIZE, remaining)` BEFORE calling
    // the pool, so a budget of 3 hands the pool a 3-item page and the pool touches
    // no more than those 3 — never overshooting by up to `concurrency`.
    const remainingBudget = 3;
    const fullPage = [10, 11, 12, 13, 14, 15, 16, 17];
    const page = fullPage.slice(0, remainingBudget);

    const processed: number[] = [];
    const results = await mapWithConcurrency(page, 8, async (item) => {
      processed.push(item);
      return item;
    });

    expect(processed.sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(results).toHaveLength(remainingBudget);
  });

  it('handles an empty batch without spawning any worker', async () => {
    let calls = 0;
    const results = await mapWithConcurrency<number, number>([], 8, async (item) => {
      calls += 1;
      return item;
    });
    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });

  it('caps the pool at the item count when concurrency exceeds it', async () => {
    const items = [1, 2];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 16, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item;
    });
    // Only 2 items exist, so the pool must never spawn more than 2 workers.
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('exposes conservative default and max concurrency constants', () => {
    expect(DEFAULT_CONCURRENCY).toBe(8);
    expect(MAX_CONCURRENCY).toBe(32);
  });
});
