/**
 * The shutdown drain waits for detached work — and the post-create broadcast
 * registers itself with it.
 *
 * `PostCreationService` hands its socket broadcast to `trackBackgroundWork`
 * rather than to a bare `void`, because a detached task belongs to neither phase
 * of `gracefulShutdown`: a SIGTERM landing mid-flight closes Postgres and the
 * socket server out from under it, and connected readers miss the update for
 * every post created in the second before a task stops. Every deploy is such a
 * stop.
 *
 * That makes this file's job narrow and specific: prove the registry actually
 * holds the drain open, prove it cannot hold it open forever, and prove the call
 * site is registered rather than merely intended to be.
 *
 * The last of those is the one that matters most, because it is the assertion
 * that fails if someone later "simplifies" the call back to `void`. It is checked
 * by reading the SOURCE, in the same spirit as
 * `rateLimitPrefixUniqueness.test.ts`, which resolves its prefixes that way for
 * the same reason: running the broadcast for real would need a socket server, a
 * hydration and an Oxy client, none of which say anything about whether the
 * promise was tracked.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  drainBackgroundWork,
  resetBackgroundWorkForTests,
  trackBackgroundWork,
  trackedBackgroundWorkCount,
} from '../../runtime/backgroundWork';

afterEach(() => {
  resetBackgroundWorkForTests();
});

/** A promise plus the handle that settles it, so a test owns the timing. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether `promise` is still pending after the microtask queue has run out. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    promise.then(() => 'settled'),
    Promise.resolve().then(() => marker),
  ]);
  return winner === marker;
}

describe('drainBackgroundWork', () => {
  it('does not resolve while a tracked task is still running', async () => {
    const task = deferred();
    trackBackgroundWork(task.promise);
    expect(trackedBackgroundWorkCount()).toBe(1);

    const drain = drainBackgroundWork(5_000);

    // THE ASSERTION. Without registration this resolves immediately, which is
    // exactly the defect: shutdown proceeds to `closePostgres()` and `io.close()`
    // while the broadcast is still hydrating.
    expect(await isPending(drain)).toBe(true);

    task.resolve();
    expect(await drain).toBe(true);
    expect(trackedBackgroundWorkCount()).toBe(0);
  });

  it('waits for every tracked task, not just the first', async () => {
    const first = deferred();
    const second = deferred();
    trackBackgroundWork(first.promise);
    trackBackgroundWork(second.promise);

    const drain = drainBackgroundWork(5_000);
    first.resolve();
    expect(await isPending(drain)).toBe(true);

    second.resolve();
    expect(await drain).toBe(true);
  });

  it('a REJECTING task drains like any other, and raises nothing', async () => {
    // Callers own their error handling; tracking must not convert a handled
    // failure into an unhandled rejection, nor into a failed drain.
    const task = deferred();
    trackBackgroundWork(task.promise);

    const drain = drainBackgroundWork(5_000);
    task.reject(new Error('broadcast failed'));

    await expect(drain).resolves.toBe(true);
  });

  it('gives up rather than blocking shutdown forever', async () => {
    // A dependency wedged open must not turn a 10s shutdown ceiling into an
    // infinite one. The task is deliberately never settled.
    trackBackgroundWork(deferred().promise);

    await expect(drainBackgroundWork(20)).resolves.toBe(false);
  });

  it('is a no-op when nothing is tracked', async () => {
    await expect(drainBackgroundWork(5_000)).resolves.toBe(true);
  });

  it('runs work past the cap rather than growing without bound', async () => {
    // Past the cap the task still runs — it is simply untracked, which degrades
    // to the old behaviour instead of to a shutdown that never completes.
    const pending: Array<{ resolve: () => void }> = [];
    for (let i = 0; i < 300; i++) {
      const task = deferred();
      pending.push(task);
      trackBackgroundWork(task.promise);
    }

    expect(trackedBackgroundWorkCount()).toBe(256);
    for (const task of pending) task.resolve();
    await drainBackgroundWork(5_000);
  });
});

describe('the post-create broadcast is registered', () => {
  it('hands the broadcast to trackBackgroundWork, not to a bare void', () => {
    const source = readFileSync(
      join(__dirname, '../../services/PostCreationService.ts'),
      'utf8',
    );

    expect(source).toContain('trackBackgroundWork(this.broadcastCreatedPost(post, oxyUserId))');
    // The shape this replaced. Its return would make the fix silently absent
    // while every other assertion in this file still passed.
    expect(source).not.toContain('void this.broadcastCreatedPost(');
  });
});
