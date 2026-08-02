import {
  TAB_NAMES,
  buildProfileTabDescriptors,
  laneTabKey,
  profileTabIndex,
  type ProfileTab,
} from '@/components/Profile/types';

const LABELS = Object.fromEntries(
  TAB_NAMES.map((tab) => [tab, `label:${tab}`]),
) as Record<ProfileTab, string>;

/**
 * The regression this file exists for: `REPLIES_TAB_INDEX = 1` and
 * `BOOSTS_TAB_INDEX = 5` were hardcoded against a fixed tuple, and a single lane
 * on the profile makes both name the wrong tab — with nothing thrown and nothing
 * logged, just a stats row that jumps somewhere else. Every assertion below
 * resolves a tab BY NAME with lanes present.
 */
describe('profile tab descriptors', () => {
  it('is exactly the static strip when the publisher has no lanes', () => {
    const descriptors = buildProfileTabDescriptors(LABELS);
    expect(descriptors.map((d) => d.key)).toEqual([...TAB_NAMES]);
    expect(descriptors.every((d) => d.laneId === undefined)).toBe(true);
  });

  it('splices lane tabs directly after posts, in order', () => {
    const descriptors = buildProfileTabDescriptors(LABELS, [
      { id: 'lane-a', name: 'dev' },
      { id: 'lane-b', name: 'photos' },
    ]);

    expect(descriptors.slice(0, 4).map((d) => d.key)).toEqual([
      'posts',
      laneTabKey('lane-a'),
      laneTabKey('lane-b'),
      'replies',
    ]);
    expect(descriptors[1]).toEqual({
      key: laneTabKey('lane-a'),
      label: 'dev',
      tab: 'posts',
      laneId: 'lane-a',
    });
    // Every static tab survives, once each.
    for (const tab of TAB_NAMES) {
      expect(descriptors.filter((d) => d.key === tab)).toHaveLength(1);
    }
  });

  it('moves the tabs the old hardcoded indices named', () => {
    const withLanes = buildProfileTabDescriptors(LABELS, [{ id: 'lane-a', name: 'dev' }]);

    // The exact breakage: index 1 is no longer `replies`, index 5 no longer
    // `boosts`. Resolving by name is what keeps the stats row honest.
    expect(withLanes[1].key).not.toBe('replies');
    expect(withLanes[5].key).not.toBe('boosts');
    expect(profileTabIndex(withLanes, 'replies')).toBe(2);
    expect(profileTabIndex(withLanes, 'boosts')).toBe(6);
    expect(profileTabIndex(withLanes, 'posts')).toBe(0);
  });

  it('falls back to the first tab for a key the strip does not have', () => {
    const descriptors = buildProfileTabDescriptors(LABELS, [{ id: 'lane-a', name: 'dev' }]);

    // A lane deep link before the lane list has loaded…
    expect(profileTabIndex(buildProfileTabDescriptors(LABELS), laneTabKey('lane-a'))).toBe(0);
    // …and a lane that has since been deleted or dropped its tab.
    expect(profileTabIndex(descriptors, laneTabKey('gone'))).toBe(0);
    // …resolve to `posts`, never to -1.
    expect(profileTabIndex(descriptors, laneTabKey('lane-a'))).toBe(1);
  });
});
