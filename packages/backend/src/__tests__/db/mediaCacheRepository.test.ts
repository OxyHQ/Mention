/**
 * `federated_media_cache` against real rows.
 *
 * Two things here are worth the cost of a database, and neither is reachable
 * from a stubbed model.
 *
 * **The access recorder's three branches partition four states**, and which
 * branch a URL takes decides whether the worker ever looks at it again. A stub
 * that returns `{matchedCount: 1}` reproduces the branch the test author had in
 * mind and proves nothing about the other two, so each state is seeded for real
 * and the resulting row is read back.
 *
 * **The insert's conflict path is unreachable sequentially.** The second of two
 * sequential calls takes the FIRST branch (the row is `pending` by then) and
 * never reaches the insert at all — so a sequential test of "call it twice"
 * exercises the bump and leaves `ON CONFLICT` completely uncovered while passing.
 * The only way to reach it is two callers racing the same absent row, which is
 * exactly the situation the clause exists for: the proxy serves concurrent
 * requests for one remote URL all the time.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb, getPostgresClient } from '../../db/postgres';
import { federatedMediaCache } from '../../db/schema/federation';
import {
  findDueMediaCacheEntries,
  findEvictableMediaCacheEntries,
  incrementMediaCacheFailCount,
  lookupMediaCacheRow,
  markMediaCacheCached,
  markMediaCacheEvicted,
  markMediaCacheFailed,
  recordMediaCacheAccess,
  scheduleMediaCacheRetry,
  touchMediaCacheAccess,
} from '../../db/federation/mediaCacheRepository';

/** Namespaces every URL this file writes, so a parallel file cannot collide. */
const ORIGIN = 'https://media-cache-repository.test';

function url(name: string): string {
  return `${ORIGIN}/${name}`;
}

/** The stored row, straight from the table — not through the repository's DTOs. */
async function readRow(remoteUrl: string) {
  const [row] = await getDb()
    .select()
    .from(federatedMediaCache)
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl))
    .limit(1);
  return row;
}

async function seed(
  remoteUrl: string,
  overrides: Partial<typeof federatedMediaCache.$inferInsert> = {},
): Promise<void> {
  await getDb()
    .insert(federatedMediaCache)
    .values({ remoteUrl, state: 'pending', failCount: 0, ...overrides });
}

/** How long to wait for the racing insert to park on the unique index. */
const BLOCK_WAIT_TIMEOUT_MS = 5_000;
/** How often to ask whether it has. */
const BLOCK_POLL_INTERVAL_MS = 20;

/**
 * Block until another session is waiting on a lock, or FAIL.
 *
 * A fixed sleep would make the staging probabilistic again in the one direction
 * that matters: too short and the racer has not reached its insert, so the test
 * passes without ever producing a conflict. Timing out throws rather than
 * proceeding, because "the race never happened" must not read as "the race was
 * survived".
 */
async function waitForBlockedInsert(): Promise<void> {
  const client = getPostgresClient();
  const deadline = Date.now() + BLOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const waiting = await client`
      select 1 from pg_stat_activity
      where wait_event_type = 'Lock'
        and datname = current_database()
        and query ilike '%federated_media_cache%'
      limit 1
    `;
    if (waiting.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        'the racing insert never blocked on the unique index, so this test never '
        + 'reached the ON CONFLICT path it exists to cover',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_INTERVAL_MS));
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb()
    .delete(federatedMediaCache)
    .where(like(federatedMediaCache.remoteUrl, `${ORIGIN}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('recording access on a remote URL', () => {
  it('inserts a pending row for a URL it has never seen', async () => {
    const target = url('unseen.jpg');

    await expect(recordMediaCacheAccess(target)).resolves.toBe(true);

    const row = await readRow(target);
    expect(row?.state).toBe('pending');
    expect(row?.failCount).toBe(0);
  });

  it.each(['pending', 'cached'] as const)(
    'only bumps access on a %s row, scheduling nothing',
    async (state) => {
      const target = url(`${state}.jpg`);
      const before = new Date('2020-01-01T00:00:00.000Z');
      await seed(target, { state, lastAccessedAt: before, failCount: 3 });

      await expect(recordMediaCacheAccess(target)).resolves.toBe(false);

      const row = await readRow(target);
      expect(row?.state).toBe(state);
      // Untouched: re-arming here would reset a live backoff and re-enqueue a
      // job that is already in flight.
      expect(row?.failCount).toBe(3);
      expect(row?.lastAccessedAt.getTime()).toBeGreaterThan(before.getTime());
    },
  );

  it.each(['evicted', 'failed'] as const)(
    're-arms a %s row to pending and clears its backoff',
    async (state) => {
      const target = url(`${state}.jpg`);
      await seed(target, {
        state,
        failCount: 5,
        nextAttemptAt: new Date('2999-01-01T00:00:00.000Z'),
      });

      await expect(recordMediaCacheAccess(target)).resolves.toBe(true);

      const row = await readRow(target);
      expect(row?.state).toBe('pending');
      expect(row?.failCount).toBe(0);
      // Left in place, the far-future backoff would hold a URL somebody is
      // actively requesting out of the worker's due set for a thousand years.
      expect(row?.nextAttemptAt).toBeNull();
    },
  );

  /**
   * The conflict path, which only a race reaches — staged so it is reached
   * EVERY run rather than whenever the scheduler happens to cooperate.
   *
   * Two bare concurrent calls do not do it: measured, one completes its insert
   * before the other reads, so the second takes the `pending` bump branch and
   * the insert never conflicts. That version passes with `ON CONFLICT` removed,
   * which makes it a test of nothing.
   *
   * Holding the row in an UNCOMMITTED transaction is what forces the collision.
   * The racer's two `UPDATE`s see no row (read committed), so it falls through
   * to the insert exactly as it would with an absent URL — and there it blocks
   * on the unique index until the transaction commits, at which point the
   * conflict is unavoidable. Without `ON CONFLICT DO UPDATE` that insert raises
   * a duplicate key and the call REJECTS.
   */
  it('survives a caller whose insert collides with a concurrent one', async () => {
    const target = url('raced.jpg');
    let racer: Promise<boolean> | undefined;

    await getDb().transaction(async (tx) => {
      await tx
        .insert(federatedMediaCache)
        .values({ remoteUrl: target, state: 'pending', failCount: 0 });

      // A different pooled connection, so it can block while this one holds the key.
      racer = recordMediaCacheAccess(target);
      await waitForBlockedInsert();
    });

    await expect(racer).resolves.toBe(true);

    const rows = await getDb()
      .select()
      .from(federatedMediaCache)
      .where(eq(federatedMediaCache.remoteUrl, target));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('pending');
  });
});

describe('the worker claim', () => {
  it('takes a never-attempted row and a row whose backoff elapsed, and no other', async () => {
    const never = url('never-attempted.jpg');
    const elapsed = url('backoff-elapsed.jpg');
    const holding = url('still-backing-off.jpg');
    const notPending = url('already-cached.jpg');

    await seed(never, { nextAttemptAt: null });
    await seed(elapsed, { nextAttemptAt: new Date('2020-01-01T00:00:00.000Z') });
    await seed(holding, { nextAttemptAt: new Date('2999-01-01T00:00:00.000Z') });
    await seed(notPending, { state: 'cached' });

    const due = await findDueMediaCacheEntries(50);

    // A never-attempted row has a NULL `next_attempt_at`; in Mongo that was two
    // alternatives (explicit null, absent field) and dropping the null branch
    // starves every first attempt while the query still looks correct.
    expect(new Set(due.filter((u) => u.startsWith(ORIGIN)))).toEqual(new Set([never, elapsed]));
  });

  it('records a backoff that holds the URL back from the next claim', async () => {
    const target = url('backing-off.jpg');
    await seed(target);

    await scheduleMediaCacheRetry(target, new Date(Date.now() + 60 * 60 * 1000));

    const due = await findDueMediaCacheEntries(50);
    expect(due).not.toContain(target);
  });
});

describe('counting failures', () => {
  it('increments and returns the new count', async () => {
    const target = url('failing.jpg');
    await seed(target, { failCount: 2 });

    await expect(incrementMediaCacheFailCount(target)).resolves.toBe(3);
  });

  /**
   * A deleted row answers `null`, NOT `0`.
   *
   * `0` is a legal fail count and would be classified as "keep retrying", so
   * collapsing the two would put the worker in a loop against a row that no
   * longer exists — the exact shape the caller now logs about instead of
   * returning silently.
   */
  it('answers null for a row that is gone rather than a count of zero', async () => {
    await expect(incrementMediaCacheFailCount(url('never-existed.jpg'))).resolves.toBeNull();
  });
});

describe('the cached and evicted transitions', () => {
  it('records what was stored and clears the backoff', async () => {
    const target = url('cacheable.jpg');
    await seed(target, { failCount: 4, nextAttemptAt: new Date('2999-01-01T00:00:00.000Z') });

    await markMediaCacheCached(target, {
      oxyFileId: 'file-1',
      posterFileId: 'poster-1',
      contentType: 'video/mp4',
      sizeBytes: 1234,
    });

    await expect(lookupMediaCacheRow(target)).resolves.toEqual({
      state: 'cached',
      oxyFileId: 'file-1',
      posterFileId: 'poster-1',
      contentType: 'video/mp4',
    });
    const row = await readRow(target);
    expect(row?.failCount).toBe(0);
    expect(row?.nextAttemptAt).toBeNull();
  });

  /**
   * A re-cache that produced no poster CLEARS the previous one.
   *
   * Mongoose stripped an `undefined` out of `$set`, so the old id survived and
   * the row went on naming a poster object this entry no longer owns — which
   * eviction would then try to delete on its behalf.
   */
  it('clears a stale poster id when the new attempt produced none', async () => {
    const target = url('was-a-video.mp4');
    await seed(target, { state: 'cached', oxyFileId: 'old', posterFileId: 'old-poster' });

    await markMediaCacheCached(target, {
      oxyFileId: 'new',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });

    expect((await readRow(target))?.posterFileId).toBeNull();
  });

  it('evicts an idle cached row, keeping the row and dropping what described the bytes', async () => {
    const target = url('idle.jpg');
    const cutoff = new Date('2024-01-01T00:00:00.000Z');
    await seed(target, {
      state: 'cached',
      oxyFileId: 'file-1',
      posterFileId: 'poster-1',
      sizeBytes: 99,
      cachedAt: new Date('2023-01-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2023-06-01T00:00:00.000Z'),
    });

    const candidates = await findEvictableMediaCacheEntries(cutoff, 50);
    expect(candidates).toContainEqual({
      remoteUrl: target,
      oxyFileId: 'file-1',
      posterFileId: 'poster-1',
    });

    await markMediaCacheEvicted(target);

    const row = await readRow(target);
    // The row SURVIVES: a later access re-enqueues it rather than rediscovering
    // the URL from scratch.
    expect(row?.state).toBe('evicted');
    expect(row?.oxyFileId).toBeNull();
    expect(row?.posterFileId).toBeNull();
    expect(row?.cachedAt).toBeNull();
    expect(row?.sizeBytes).toBeNull();
  });

  /**
   * The eviction write is scoped to `state = 'cached'`.
   *
   * The sweep reads its candidates, then deletes their S3 objects, then writes —
   * and an access arriving in that window re-arms the row to `pending`. Without
   * the state term the write would stamp `evicted` over that, stranding a URL
   * somebody is actively requesting.
   */
  it('refuses to evict a row that was re-armed since it was listed', async () => {
    const target = url('re-armed.jpg');
    await seed(target, { state: 'pending' });

    await markMediaCacheEvicted(target);

    expect((await readRow(target))?.state).toBe('pending');
  });

  it('marks a permanently un-cacheable URL failed and clears its backoff', async () => {
    const target = url('not-media.html');
    await seed(target, { nextAttemptAt: new Date('2999-01-01T00:00:00.000Z') });

    await markMediaCacheFailed(target);

    const row = await readRow(target);
    expect(row?.state).toBe('failed');
    expect(row?.nextAttemptAt).toBeNull();
  });
});

describe('the proxy read path', () => {
  it('answers undefined for a URL with no row', async () => {
    await expect(lookupMediaCacheRow(url('absent.jpg'))).resolves.toBeUndefined();
  });

  it('omits absent optionals rather than handing back null', async () => {
    const target = url('bare-pending.jpg');
    await seed(target);

    await expect(lookupMediaCacheRow(target)).resolves.toEqual({
      state: 'pending',
      oxyFileId: undefined,
      posterFileId: undefined,
      contentType: undefined,
    });
  });

  it('bumps access without disturbing anything else', async () => {
    const target = url('bumped.jpg');
    const before = new Date('2020-01-01T00:00:00.000Z');
    await seed(target, { state: 'cached', lastAccessedAt: before, oxyFileId: 'file-1' });

    await touchMediaCacheAccess(target);

    const row = await readRow(target);
    expect(row?.lastAccessedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(row?.state).toBe('cached');
    expect(row?.oxyFileId).toBe('file-1');
  });
});

describe('cleanup', () => {
  it('leaves no rows of its own behind', async () => {
    const rows = await getDb()
      .select({ remoteUrl: federatedMediaCache.remoteUrl })
      .from(federatedMediaCache)
      .where(inArray(federatedMediaCache.remoteUrl, [url('unseen.jpg'), url('raced.jpg')]));
    expect(rows).toEqual([]);
  });
});
