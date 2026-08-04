import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for {@link UserPreferenceService} REGION-affinity learning off the
 * (best-effort, often-absent) `postClassification.region` of an engaged post.
 *
 * The service must:
 *   - accumulate a counted `preferredRegions` entry on a POSITIVE engagement
 *     when the post carries a region,
 *   - NO-OP when the post has no region (the common case — region is sparse),
 *   - NO-OP for a negative signal (a `skip` must not grow region interest), and
 *   - expose the DOMINANT region via `getTopRegion` (highest count), returning
 *     `undefined` when none has been learned.
 *
 * ## What changed with the Postgres port
 *
 * BOTH sides are real rows now. The post already was one; `UserBehavior` was a
 * mock whose `preferredRegions` array the assertions read back, which asserted
 * that the service mutates an object it was handed — true of any implementation,
 * including one whose write never reaches a column. `preferredRegions` is a
 * child TABLE now, so a count that is accumulated but not persisted, or
 * persisted into a column nothing reads back, fails here.
 *
 * That also makes the "post is gone" case sharper: the assertion is that NO
 * behaviour row exists afterwards, not merely that a `save` spy went uncalled.
 */

vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  deleteUserBehavior,
  loadUserBehavior,
} from '../../db/userProfile/userBehaviorRepository';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { userPreferenceService } from '../../services/UserPreferenceService';

const scope = serviceScope('user-pref-region');
const VIEWER = scope.user('viewer');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
});

afterEach(async () => {
  await clearServiceScope(scope);
  await deleteUserBehavior(VIEWER);
});

afterAll(async () => {
  await closePostgres();
});

/** The viewer's stored region affinities, keyed by region code. */
async function storedRegions(): Promise<Map<string, number>> {
  const behavior = await loadUserBehavior(VIEWER);
  return new Map((behavior?.preferredRegions ?? []).map((entry) => [entry.region, entry.count]));
}

describe('UserPreferenceService — region-affinity learning', () => {
  it('learns a region from an engaged post whose stored classification carries one', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [], region: 'ES' },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(await storedRegions()).toEqual(new Map([['ES', 1]]));
  });

  it('NO-OPs (learns no region) when the stored post has no region — the common case', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(await storedRegions()).toEqual(new Map());
    // The interaction still landed — only the region accumulator stayed empty.
    // Asserting a positive effect matters: an empty region set is also what a
    // write that never happened at all looks like.
    const behavior = await loadUserBehavior(VIEWER);
    expect(behavior?.preferredPostTypes.text).toBe(1);
  });

  it('NO-OPs for a negative signal (skip must not grow region interest)', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [], region: 'DE' },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'skip');

    expect(await storedRegions()).toEqual(new Map());
  });

  it('accumulates the same region across multiple engagements (counted multiset)', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [], region: 'US' },
    });

    // The count accumulates the interaction WEIGHT, not a plain +1 — a like is
    // 1.0 and a boost 2.0 — so the exact total is 3. Asserting the exact value
    // rather than "greater than before" is what makes a weight silently
    // collapsing to a constant visible.
    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');
    expect(await storedRegions()).toEqual(new Map([['US', 1]]));
    await userPreferenceService.recordInteraction(VIEWER, post.id, 'boost');

    expect(await storedRegions()).toEqual(new Map([['US', 3]]));
  });

  it('learns nothing at all when the post id resolves to no row', async () => {
    // The service must not invent an interaction for a post that is gone: a
    // deleted post's id arriving from stale client telemetry is the real case.
    await userPreferenceService.recordInteraction(VIEWER, '019000000000000000000000000', 'like');

    expect(await loadUserBehavior(VIEWER)).toBeNull();
  });
});

describe('UserPreferenceService.getTopRegion', () => {
  it('returns the dominant (highest-count) region', () => {
    const top = userPreferenceService.getTopRegion({
      preferredRegions: [
        { region: 'ES', count: 2 },
        { region: 'US', count: 9 },
        { region: 'DE', count: 5 },
      ],
    });
    expect(top).toBe('US');
  });

  it('returns undefined when the viewer has learned no region', () => {
    expect(userPreferenceService.getTopRegion({ preferredRegions: [] })).toBeUndefined();
    expect(userPreferenceService.getTopRegion(undefined)).toBeUndefined();
    expect(userPreferenceService.getTopRegion(null)).toBeUndefined();
  });

  it('ignores malformed entries (missing/empty region)', () => {
    const top = userPreferenceService.getTopRegion({
      preferredRegions: [
        { region: '', count: 100 },
        { region: 'FR', count: 3 },
      ],
    });
    expect(top).toBe('FR');
  });
});
