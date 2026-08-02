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
 * The post is a REAL ROW. It used to be a `models/Post` mock returning a literal
 * `{ postClassification: { region: 'ES' } }`, which asserted that the service
 * reads a field off whatever object it is handed — true of any implementation,
 * including one that reads a column the writer never stores. `region` is now a
 * real column that has to survive `insertPostRecord` → `loadPostRecord`, so a
 * region that is written but not read back (or vice versa) fails here.
 *
 * `UserBehavior` is still Mongoose and stays mocked: the accumulator it holds is
 * what these tests are about, and it is not part of this port.
 */

const mocks = vi.hoisted(() => ({ findOne: vi.fn() }));

vi.mock('../../models/UserBehavior', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => mocks.findOne(filter) },
}));
vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { userPreferenceService } from '../../services/UserPreferenceService';

interface RegionPref {
  region: string;
  count: number;
  lastInteractionAt: Date;
}

interface MockBehavior {
  oxyUserId: string;
  preferredAuthors: unknown[];
  preferredTopics: unknown[];
  preferredPostTypes: Record<string, number>;
  activeHours: number[];
  preferredLanguages: string[];
  preferredRegions: RegionPref[];
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
  lastUpdated?: Date;
  markModified: () => void;
  save: () => Promise<void>;
}

const scope = serviceScope('user-pref-region');
const VIEWER = scope.user('viewer');

function makeBehavior(): MockBehavior {
  return {
    oxyUserId: VIEWER,
    preferredAuthors: [],
    preferredTopics: [],
    preferredPostTypes: { text: 0, image: 0, video: 0, poll: 0 },
    activeHours: [],
    preferredLanguages: [],
    preferredRegions: [],
    hiddenAuthors: [],
    mutedAuthors: [],
    blockedAuthors: [],
    hiddenTopics: [],
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

let behavior: MockBehavior;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  behavior = makeBehavior();
  mocks.findOne.mockResolvedValue(behavior);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

function regionPref(code: string): RegionPref | undefined {
  return behavior.preferredRegions.find((r) => r.region === code);
}

describe('UserPreferenceService — region-affinity learning', () => {
  it('learns a region from an engaged post whose stored classification carries one', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [], region: 'ES' },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    const pref = regionPref('ES');
    expect(pref).toBeDefined();
    expect(pref?.count).toBe(1);
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('NO-OPs (learns no region) when the stored post has no region — the common case', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [] },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'like');

    expect(behavior.preferredRegions).toHaveLength(0);
    // The interaction still landed — only the region accumulator stayed empty.
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('NO-OPs for a negative signal (skip must not grow region interest)', async () => {
    const post = await seedPost(scope, {
      postClassification: { status: 'baseline', topics: [], region: 'DE' },
    });

    await userPreferenceService.recordInteraction(VIEWER, post.id, 'skip');

    expect(behavior.preferredRegions).toHaveLength(0);
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
    expect(regionPref('US')?.count).toBe(1);
    await userPreferenceService.recordInteraction(VIEWER, post.id, 'boost');

    expect(behavior.preferredRegions).toHaveLength(1);
    expect(regionPref('US')?.count).toBe(3);
  });

  it('learns nothing at all when the post id resolves to no row', async () => {
    // The service must not invent an interaction for a post that is gone: a
    // deleted post's id arriving from stale client telemetry is the real case.
    await userPreferenceService.recordInteraction(VIEWER, '019000000000000000000000000', 'like');

    expect(behavior.preferredRegions).toHaveLength(0);
    expect(behavior.save).not.toHaveBeenCalled();
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
