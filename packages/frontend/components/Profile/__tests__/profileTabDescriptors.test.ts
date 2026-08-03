import {
  CHANNEL_ONLY_TAB_NAMES,
  TAB_NAMES,
  buildProfileTabDescriptors,
  laneTabKey,
  profileTabIndex,
  profileTabsForAccountKind,
  type ProfileTab,
} from '@/components/Profile/types';

const LABELS: Record<ProfileTab, string> = Object.fromEntries(
  [...TAB_NAMES, ...CHANNEL_ONLY_TAB_NAMES].map((tab) => [tab, `label:${tab}`]),
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

  it('gives a channel only the tabs its account kind can fill', () => {
    expect(profileTabsForAccountKind('channel')).toEqual([
      'posts',
      'media',
      'videos',
      'boosts',
      // Channel-only, and last: this asks the account kind whether the tab is
      // POSSIBLE, not whether this particular channel gets it — that second
      // question is `disclosesWriters`, and it lives in the descriptor builder.
      'writers',
    ]);
  });

  it('offers the writers tab to a channel and to nobody else', () => {
    expect(profileTabsForAccountKind('channel')).toContain('writers');
    for (const kind of ['personal', 'organization', 'project', 'bot', undefined] as const) {
      expect(profileTabsForAccountKind(kind)).not.toContain('writers');
    }
  });

  /**
   * The five are dropped for five DIFFERENT reasons (see `CHANNEL_EXCLUDED_TABS`),
   * so they are asserted one at a time: a single `toEqual` on the whole strip
   * cannot say which one a future change put back.
   */
  it.each(['replies', 'likes', 'feeds', 'starter_packs', 'lists'] as const)(
    'drops the %s tab on a channel',
    (tab) => {
      expect(profileTabsForAccountKind('channel')).not.toContain(tab);
      expect(profileTabsForAccountKind(undefined)).toContain(tab);
    },
  );

  it('keeps the boosts tab on a channel', () => {
    expect(profileTabsForAccountKind('channel')).toContain('boosts');
  });

  it.each(['personal', 'organization', 'project', 'bot', undefined] as const)(
    'leaves the full strip alone for kind %s',
    (kind) => {
      expect(profileTabsForAccountKind(kind)).toEqual([...TAB_NAMES]);
    },
  );

  it('still splices a channel’s lanes directly after posts', () => {
    const descriptors = buildProfileTabDescriptors(
      LABELS,
      [{ id: 'lane-a', name: 'dev' }],
      'channel',
    );

    expect(descriptors.map((d) => d.key)).toEqual([
      'posts',
      laneTabKey('lane-a'),
      'media',
      'videos',
      'boosts',
    ]);
  });

  /**
   * The writers tab is the one tab whose presence the account KIND cannot
   * decide: every channel could have one, only a channel that NAMES its writers
   * gets one. Both directions are asserted here — a fixture that only ever
   * disclosed could not tell "tab when disclosing" from "tab always".
   */
  it('adds the writers tab to a channel that discloses, and only then', () => {
    const disclosing = buildProfileTabDescriptors(LABELS, [], 'channel', true);
    const notDisclosing = buildProfileTabDescriptors(LABELS, [], 'channel', false);

    expect(disclosing.map((d) => d.key)).toEqual([
      'posts',
      'media',
      'videos',
      'boosts',
      'writers',
    ]);
    expect(notDisclosing.map((d) => d.key)).toEqual(['posts', 'media', 'videos', 'boosts']);
    // The two must actually differ; if they ever stop differing, the tab has
    // become unconditional and every assertion above still passes.
    expect(disclosing.map((d) => d.key)).not.toEqual(notDisclosing.map((d) => d.key));
  });

  it('defaults the writers tab to ABSENT, so a missing answer names nobody', () => {
    const descriptors = buildProfileTabDescriptors(LABELS, [], 'channel');
    expect(descriptors.map((d) => d.key)).not.toContain('writers');
  });

  it('never gives a person a writers tab, however the disclosure flag is set', () => {
    for (const disclosed of [true, false]) {
      const descriptors = buildProfileTabDescriptors(LABELS, [], 'personal', disclosed);
      expect(descriptors.map((d) => d.key)).toEqual([...TAB_NAMES]);
    }
  });

  it('lands a channel on posts for a tab its strip no longer has', () => {
    const descriptors = buildProfileTabDescriptors(LABELS, [], 'channel');

    // What a stale deep link or the stats row asks for; `profileTabIndex`'s
    // fallback is what keeps it from resolving to -1 and rendering nothing.
    expect(profileTabIndex(descriptors, 'likes')).toBe(0);
    expect(profileTabIndex(descriptors, 'lists')).toBe(0);
    expect(profileTabIndex(descriptors, 'boosts')).toBe(3);
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
