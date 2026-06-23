import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link UserPreferenceService} REGION-affinity learning off
 * the (best-effort, often-absent) `postClassification.region` of an engaged post.
 *
 * The service must:
 *   - accumulate a counted `preferredRegions` entry on a POSITIVE engagement
 *     when the post carries a region,
 *   - NO-OP when the post has no region (the common case — region is sparse),
 *   - NO-OP for a negative signal (a `skip` must not grow region interest), and
 *   - expose the DOMINANT region via `getTopRegion` (highest count), returning
 *     `undefined` when none has been learned.
 *
 * The Post and UserBehavior models are mocked (no DB); we drive interactions and
 * assert the in-memory `preferredRegions` multiset.
 */

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

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: { findById: (id: string) => ({ lean: () => mocks.findById(id) }) },
}));
vi.mock('../../models/UserBehavior', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => mocks.findOne(filter),
  },
}));
vi.mock('../../models/Like', () => ({ __esModule: true, default: { find: vi.fn() } }));
vi.mock('../../models/Bookmark', () => ({ __esModule: true, default: { find: vi.fn() } }));

import { userPreferenceService } from '../../services/UserPreferenceService';

function makeBehavior(): MockBehavior {
  return {
    oxyUserId: 'viewer-1',
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

beforeEach(() => {
  vi.clearAllMocks();
  behavior = makeBehavior();
  mocks.findOne.mockResolvedValue(behavior);
});

function regionPref(code: string): RegionPref | undefined {
  return behavior.preferredRegions.find((r) => r.region === code);
}

describe('UserPreferenceService — region-affinity learning', () => {
  it('learns a region from an engaged post that carries postClassification.region', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p1',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: { status: 'baseline', topics: [], region: 'ES' },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p1', 'like');

    const pref = regionPref('ES');
    expect(pref).toBeDefined();
    expect(pref?.count).toBeGreaterThan(0);
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('NO-OPs (learns no region) when the post has no region — the common case', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p2',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: { status: 'baseline', topics: [] }, // region absent
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p2', 'like');

    expect(behavior.preferredRegions).toHaveLength(0);
    expect(behavior.save).toHaveBeenCalledTimes(1);
  });

  it('NO-OPs for a negative signal (skip must not grow region interest)', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p3',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: { status: 'baseline', topics: [], region: 'DE' },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p3', 'skip');

    expect(behavior.preferredRegions).toHaveLength(0);
  });

  it('accumulates the same region across multiple engagements (counted multiset)', async () => {
    mocks.findById.mockResolvedValue({
      _id: 'p4',
      oxyUserId: 'author-1',
      type: 'text',
      hashtags: [],
      postClassification: { status: 'baseline', topics: [], region: 'US' },
    });

    await userPreferenceService.recordInteraction('viewer-1', 'p4', 'like');
    const firstCount = regionPref('US')?.count ?? 0;
    await userPreferenceService.recordInteraction('viewer-1', 'p4', 'boost');

    expect(behavior.preferredRegions).toHaveLength(1);
    expect((regionPref('US')?.count ?? 0)).toBeGreaterThan(firstCount);
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
