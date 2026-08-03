const mockInvalidate = jest.fn();

jest.mock('@/lib/queryClient', () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => mockInvalidate(...args),
  },
}));

import {
  isLaneFeedCacheStale,
  noteLaneListsChanged,
  resetLaneInvalidation,
} from '@/stores/laneInvalidation';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The half of this module that nothing else can cover: a React-Query-only
 * invalidation is a no-op on every `<Feed>` surface, so the timestamp gate below
 * IS the fix for the feed store. Each case pins one reach claim from the
 * docstring; break one and the surface it names silently keeps its pre-write
 * membership until a full reload.
 */
describe('lane list invalidation', () => {
  const VIEWER = 'viewer-1';

  beforeEach(() => {
    mockInvalidate.mockClear();
    resetLaneInvalidation();
  });

  afterEach(() => {
    resetLaneInvalidation();
  });

  it('leaves every feed alone until a lane write lands', () => {
    expect(isLaneFeedCacheStale(VIEWER, VIEWER, undefined, 0)).toBe(false);
    expect(isLaneFeedCacheStale('other', VIEWER, 'lane-1', 0)).toBe(false);
  });

  it('stales EVERY feed after a mute — it is a filter over all of them', () => {
    const before = Date.now() - 1;
    noteLaneListsChanged('mute');

    // Somebody else's profile, the viewer's own, and a lane tab alike.
    expect(isLaneFeedCacheStale('other-author', VIEWER, undefined, before)).toBe(true);
    expect(isLaneFeedCacheStale(VIEWER, VIEWER, undefined, before)).toBe(true);
    expect(isLaneFeedCacheStale(undefined, VIEWER, 'lane-1', before)).toBe(true);
    // A global feed (no subject at all) is reached too.
    expect(isLaneFeedCacheStale(undefined, VIEWER, undefined, before)).toBe(true);
  });

  it('stales only the acting viewer’s own showcase after an assignment', () => {
    const before = Date.now() - 1;
    noteLaneListsChanged('assignment');

    // The viewer's own profile, and any lane tab: both moved.
    expect(isLaneFeedCacheStale(VIEWER, VIEWER, undefined, before)).toBe(true);
    expect(isLaneFeedCacheStale(undefined, VIEWER, 'lane-1', before)).toBe(true);
    // Somebody else's profile and the global feeds did not.
    expect(isLaneFeedCacheStale('other-author', VIEWER, undefined, before)).toBe(false);
    expect(isLaneFeedCacheStale(undefined, VIEWER, undefined, before)).toBe(false);
    // Nor an anonymous reader's own-profile lookalike: with no viewer id there
    // is no "own" profile to have changed.
    expect(isLaneFeedCacheStale(undefined, undefined, undefined, before)).toBe(false);
  });

  it('treats a slice retained AFTER the write as already current', () => {
    noteLaneListsChanged('mute');
    const after = Date.now() + 1000;
    expect(isLaneFeedCacheStale(VIEWER, VIEWER, 'lane-1', after)).toBe(false);
  });

  it('invalidates the lane collections React Query owns, and only those', () => {
    noteLaneListsChanged('assignment');

    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    const { predicate } = mockInvalidate.mock.calls[0][0] as {
      predicate: (query: { queryKey: readonly unknown[] }) => boolean;
    };

    expect(predicate({ queryKey: viewerQueryKeys.ownedLanes(VIEWER) })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.mutedLanes(VIEWER) })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.lanesForOwner(VIEWER, 'a') })).toBe(true);
    // A different viewer's lanes still match the family — an account switch
    // drops that namespace wholesale, so "this family, whoever it belongs to"
    // and "this family, for the signed-in viewer" describe the same entries.
    expect(predicate({ queryKey: viewerQueryKeys.ownedLanes('viewer-2') })).toBe(true);
    // Nothing else.
    expect(predicate({ queryKey: viewerQueryKeys.savedPosts(VIEWER, '', null) })).toBe(false);
    expect(predicate({ queryKey: viewerQueryKeys.muteWords(VIEWER) })).toBe(false);
  });
});
