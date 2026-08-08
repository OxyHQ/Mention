import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Concurrency coverage for {@link UserPreferenceService.recordInteraction}.
 *
 * Feed-impression telemetry fires many concurrent interactions for the SAME
 * viewer, and the write is a read-modify-write over stateful accumulators, so
 * two writers racing on one behaviour row is the ordinary case rather than an
 * edge one. The guarantee is that none of them is LOST.
 *
 * ## What the Postgres port changed here
 *
 * The mechanism is different, so these tests are different. Mongoose gave the
 * write optimistic concurrency: the loser's `.save()` raised a `VersionError`
 * and the service caught it, re-read and re-applied, up to five times. The
 * previous version of this file staged those races on a mocked model — it
 * asserted that a spy rejecting with a `VersionError` caused a second `findOne`,
 * which is a statement about the retry loop and not about any stored value.
 *
 * `updateUserBehavior` now takes `SELECT … FOR UPDATE` on the row before reading
 * it, so the loser BLOCKS and then applies its mutation to the winner's
 * committed state. That is a property of the database, and it is only observable
 * under genuine concurrency — so every case below runs real interleaved
 * transactions against real rows, and the two that turn on the lock assert what
 * a lost update would destroy: the SUM of what the racers each contributed.
 *
 * The lock ORDER matters as much as the lock. An `UPDATE` alone would also
 * serialize the writers, and would still lose an update — the loser would have
 * read the pre-image before waiting. `blocks a second writer BEFORE it reads`
 * below is what pins the read to the locked side of the boundary.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userBehaviors } from '../../db/schema/userProfile';
import {
  deleteUserBehavior,
  loadUserBehavior,
  updateUserBehavior,
} from '../../db/userProfile/userBehaviorRepository';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { userPreferenceService } from '../../services/UserPreferenceService';

const scope = serviceScope('user-pref-concurrency');
const VIEWER = scope.user('viewer');
const AUTHOR = scope.user('author');

/** Concurrent interactions per contention case. */
const CONCURRENT_LIKES = 3;
/** How long a blocked racer is given to (incorrectly) proceed before we conclude it blocked. */
const BLOCK_OBSERVATION_MS = 300;
/** How long a released racer may take to finish before the test FAILS rather than hangs. */
const RELEASE_TIMEOUT_MS = 5_000;

/** The post every interaction below is about. Seeded once — it is not the subject. */
let likedPostId: string;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
  likedPostId = (await seedPost(scope, { oxyUserId: AUTHOR })).id;
  // Without a readable row `recordInteraction` returns before touching the
  // behaviour at all, so every contention assertion below would hold vacuously.
  // Assert it, once.
  expect((await readPost(likedPostId))?.oxyUserId).toBe(AUTHOR);
});

afterEach(async () => {
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
});

afterAll(async () => {
  await closePostgres();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Await `work`, or THROW when it takes longer than {@link RELEASE_TIMEOUT_MS}.
 *
 * A bare `await` on a write that never unblocks hangs the whole file until
 * vitest's own timeout kills it, which reports as a slow suite rather than as
 * the broken guarantee it is.
 */
async function withReleaseTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not complete within ${RELEASE_TIMEOUT_MS}ms`)),
          RELEASE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The viewer's stored author preference for {@link AUTHOR}. */
async function authorPreference() {
  const behavior = await loadUserBehavior(VIEWER);
  return behavior?.preferredAuthors.find((a) => a.authorId === AUTHOR);
}

describe('UserPreferenceService.recordInteraction — concurrent writes', () => {
  it('loses no update when several interactions for one viewer run concurrently', async () => {
    // Issued WITHOUT awaiting in between: three transactions are open at once and
    // contend for the same row. Serialising them would still pass and would cover
    // nothing.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_LIKES }, () =>
        userPreferenceService.recordInteraction(VIEWER, likedPostId, 'like'),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }

    // THE assertion. Each like adds exactly one to the per-type counter and 1.0
    // to the accumulated weight, so anything less than the full sum is an update
    // that was read, mutated and then overwritten by a racer.
    const preference = await authorPreference();
    expect(preference?.interactionTypes.likes).toBe(CONCURRENT_LIKES);
    expect(preference?.interactionCount).toBeCloseTo(CONCURRENT_LIKES, 6);
  });

  it('creates exactly ONE behaviour row when concurrent FIRST interactions race', async () => {
    // Nothing exists for this viewer yet (the beforeEach deleted it), so every
    // racer takes the create path. The unique key on `oxy_user_id` is what makes
    // the loser wait rather than insert a second row, and the upsert is what
    // makes it then proceed rather than raise.
    expect(await loadUserBehavior(VIEWER)).toBeNull();

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_LIKES }, () =>
        userPreferenceService.recordInteraction(VIEWER, likedPostId, 'like'),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }

    const rows = await getDb()
      .select({ id: userBehaviors.id })
      .from(userBehaviors)
      .where(eq(userBehaviors.oxyUserId, VIEWER));
    expect(rows).toHaveLength(1);
    expect((await authorPreference())?.interactionTypes.likes).toBe(CONCURRENT_LIKES);
  });

  it('blocks a second writer BEFORE it reads, so it cannot derive a value from a stale row', async () => {
    // Establish the row, then hold it in an uncommitted transaction.
    await userPreferenceService.recordInteraction(VIEWER, likedPostId, 'like');

    let racerRead = false;
    let racer: Promise<boolean> | undefined;

    await getDb().transaction(async (tx) => {
      await tx
        .select()
        .from(userBehaviors)
        .where(eq(userBehaviors.oxyUserId, VIEWER))
        .for('update');

      racer = updateUserBehavior(VIEWER, (behavior) => {
        racerRead = true;
        behavior.averageEngagementTime = behavior.averageEngagementTime + 1;
      });

      await sleep(BLOCK_OBSERVATION_MS);
      // The racer is queued on the row lock and has NOT yet read the record. Were
      // the lock taken only by the final UPDATE, it would have read the row by
      // now and be about to write a value derived from it.
      expect(racerRead).toBe(false);
    });

    // Released — and it must actually finish, not merely be unblocked.
    expect(await withReleaseTimeout(racer as Promise<boolean>, 'the blocked writer')).toBe(true);
    expect(racerRead).toBe(true);
    expect((await loadUserBehavior(VIEWER))?.averageEngagementTime).toBe(1);
  });

  it('refuses to create a row for a viewer who has none when createIfMissing is not set', async () => {
    // The two refine-only callers (`recordViewTime`, `batchUpdatePreferences`)
    // rely on this to tell "there was nothing to refine" from "refined it": a
    // silent create would give every viewer an empty behaviour profile.
    let applied = false;
    const mutated = await updateUserBehavior(VIEWER, () => {
      applied = true;
    });

    expect(mutated).toBe(false);
    expect(applied).toBe(false);
    expect(await loadUserBehavior(VIEWER)).toBeNull();
  });
});
