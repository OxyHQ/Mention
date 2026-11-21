jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  avatarCharacterInColor: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).avatarCharacterInColor,
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: true }),
}));
import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The person row follows the identity it names.
 *
 * `ProfileCard` is ONE component and fifteen surfaces: search results,
 * who-to-follow, the widget, list and starter-pack members, followers and
 * following, likers and boosters, collaborators, pokes, notification
 * subscriptions and both feed interstitials. Each hands it a `profile` snapshot
 * its own fetch produced, and nothing rewrites those — so a picture changed
 * after that fetch stayed wrong on every one of them until a reload, exactly as
 * it did on a post row. Resolving it in the row, from the person the Oxy SDK's
 * `User` holds, is what reaches all fifteen; a correction per surface is fifteen
 * chances to forget one.
 *
 * The mocks below exist only to keep untransformed ESM out of the module graph,
 * the same reason `PostDetailStats.test.tsx` mocks its Bloom subpaths. `Avatar`
 * and `UserName` are the two that carry the answer, so they are stand-ins that
 * report what they were handed rather than `null`.
 */

jest.mock('@oxy.so/bloom/list', () => require('@/test-support/bloomPersonList'));
jest.mock('@oxy.so/bloom/avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    Avatar: (props: { source?: string | null; account?: unknown; motion?: string }) =>
      ReactActual.createElement(
        ReactActual.Fragment,
        null,
        ReactActual.createElement(Text, { testID: 'card-avatar' }, props.source ?? ''),
        ReactActual.createElement(
          Text,
          { testID: 'card-character' },
          JSON.stringify({ account: props.account, motion: props.motion }),
        ),
      ),
  };
});
jest.mock('@/components/UserName', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: (props: { name?: string; handle?: string }) =>
      ReactActual.createElement(
        Text,
        { testID: 'card-name' },
        `${props.name ?? ''}|${props.handle ?? ''}`,
      ),
  };
});
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
/** The `username` each rendered FollowButton received. */
const mockFollowButtonUsernames: (string | undefined)[] = [];
jest.mock('@oxy.so/services/ui/client', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useAuth: () => ({ user: { id: 'viewer' } }),
    useAuthStore: { getState: () => ({ user: { id: 'viewer' } }) },
    ...jest.requireActual('@/test-support/oxyUsers'),
    FollowButton: ({
      onFollowChange,
      username,
    }: {
      onFollowChange?: (next: boolean) => void;
      username?: string;
    }) => {
      mockFollowButtonUsernames.push(username);
      return ReactActual.createElement(TouchableOpacity, {
        testID: 'follow-control',
        onPress: () => onFollowChange?.(true),
      });
    },
  };
});
jest.mock('@oxy.so/bloom/typography', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Text };
});
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: () => null, Group: () => null }));
jest.mock('@oxy.so/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() },
}));
jest.mock('@/utils/userPlaceholderColor', () => ({
  getUserPlaceholderColor: () => '#888888',
}));

import { ProfileCard } from '@/components/ProfileCard';
import { SuggestedProfileCard } from '@/components/SuggestedProfileCard';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { storeUsers } from '@oxy.so/services/ui/client';

const PERSON_ID = 'person-1';
/** When the surface fetched its copy, and when the edit landed at Oxy. */
const FETCHED_AT = '2026-08-01T00:00:00.000Z';
const EDITED_AT = '2026-08-02T00:00:00.000Z';

/**
 * An accepted profile write, as the SDK stores Oxy's answer in `User`: with the
 * `updatedAt` Oxy gave it.
 */
function edit(person: { id: string; [field: string]: unknown }, at = EDITED_AT): void {
  storeUsers({ ...person, updatedAt: at });
}

beforeEach(() => {
  setActiveStore(new Store());
});

let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderRow() {
  act(() => {
    mounted = TestRenderer.create(
      <ProfileCard
        profile={{
          id: PERSON_ID,
          username: 'ada',
          name: { displayName: 'Ada' },
          avatar: 'avatar-before',
          updatedAt: FETCHED_AT,
        }}
      />,
    );
  });
  if (!mounted) throw new Error('the row did not render');
  return mounted;
}

function probe(renderer: TestRenderer.ReactTestRenderer, testID: string): string {
  return String(renderer.root.findByProps({ testID }).props.children);
}

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
  jest.clearAllMocks();
});

describe('ProfileCard follows the identity it names', () => {
  it('shows what its surface fetched when nothing has been edited', () => {
    const renderer = renderRow();
    expect(probe(renderer, 'card-avatar')).toBe('avatar-before');
    expect(probe(renderer, 'card-name')).toBe('Ada|ada');
  });

  it('repaints a MOUNTED row when that profile is edited — no refetch', () => {
    const renderer = renderRow();

    act(() => {
      edit({
        id: PERSON_ID,
        username: 'ada',
        name: { displayName: 'Ada Lovelace' },
        avatar: 'avatar-after',
      });
    });

    expect(probe(renderer, 'card-avatar')).toBe('avatar-after');
    expect(probe(renderer, 'card-name')).toBe('Ada Lovelace|ada');
  });

  it('follows a RENAME into the handle the row links to', () => {
    const renderer = renderRow();

    act(() => {
      edit({ id: PERSON_ID, username: 'ada-l' });
    });

    // Not cosmetic: the handle is what the row navigates to, so a stale one is a
    // tap that 404s.
    expect(probe(renderer, 'card-name')).toBe('Ada|ada-l');
  });

  it('keeps the follow control outside the profile navigation target', () => {
    const onFollowChange = jest.fn();
    act(() => {
      mounted = TestRenderer.create(
        <ProfileCard
          profile={{ id: PERSON_ID, username: 'ada' }}
          size="sm"
          showFollowButton
          onFollowChange={onFollowChange}
        />,
      );
    });
    const follow = mounted!.root.findByProps({ testID: 'follow-control' });
    act(() => follow.props.onPress());
    expect(onFollowChange).toHaveBeenCalledWith(true);
    expect(mockPush).not.toHaveBeenCalled();
    // The shared row's open target and trailing follow action stay independent.
    const row = mounted!.root.findByProps({ testID: 'profile-row-open' });
    expect(row.findAllByProps({ testID: 'follow-control' })).toHaveLength(0);
    act(() => row.props.onPress());
    expect(mockPush).toHaveBeenCalled();
  });

  it('keeps its own copy when the one held is older', () => {
    act(() => {
      edit({ id: PERSON_ID, avatar: 'avatar-older' }, '2026-07-01T00:00:00.000Z');
    });

    const renderer = renderRow();
    expect(probe(renderer, 'card-avatar')).toBe('avatar-before');
  });

  it('never shows the "Unknown user" placeholder over the person it fetched', () => {
    act(() => {
      // An Oxy outage hydrates a degraded copy, which carries no `updatedAt`.
      storeUsers({ id: PERSON_ID, username: '', name: { displayName: 'Unknown user' } });
    });

    const renderer = renderRow();
    expect(probe(renderer, 'card-name')).toBe('Ada|ada');
  });

  it('leaves every other person alone', () => {
    const renderer = renderRow();

    act(() => {
      edit({ id: 'someone-else', avatar: 'avatar-after' });
    });

    expect(probe(renderer, 'card-avatar')).toBe('avatar-before');
  });
});

describe('ProfileCard names its follow button', () => {
  it('hands the handle to FollowButton so a screen reader hears "Following @ada"', () => {
    // OxyHQ/oxy#1375 item 22: the button showed "Following" while TalkBack read
    // "Follow". Services names it by state and handle once it has the handle.
    act(() => {
      mounted = TestRenderer.create(
        <ProfileCard
          profile={{ id: PERSON_ID, username: 'ada', name: { displayName: 'Ada' } }}
          showFollowButton
        />,
      );
    });
    expect(mockFollowButtonUsernames[mockFollowButtonUsernames.length - 1]).toBe('ada');
  });
});

describe('SuggestedProfileCard resolves its identity the way the row does', () => {
  function renderTile(profile: React.ComponentProps<typeof SuggestedProfileCard>['profile']) {
    act(() => {
      mounted = TestRenderer.create(<SuggestedProfileCard profile={profile} />);
    });
    if (!mounted) throw new Error('the tile did not render');
    return mounted;
  }

  it('repaints a MOUNTED tile when that profile is edited, and links to the new handle', () => {
    const renderer = renderTile({
      id: PERSON_ID,
      username: 'ada',
      name: { displayName: 'Ada' },
      avatar: 'avatar-before',
    });

    act(() => {
      edit({ id: PERSON_ID, username: 'ada-l', avatar: 'avatar-after' });
    });

    expect(probe(renderer, 'card-avatar')).toBe('avatar-after');
    expect(probe(renderer, 'card-name')).toBe('Ada|ada-l');
  });

  it('degrades a profile with no name and no handle to "Unknown user", and does not link it', () => {
    const renderer = renderTile({ id: PERSON_ID });

    expect(probe(renderer, 'card-name')).toBe('Unknown user|');
    const target = renderer.root.findAll(
      (node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function',
    );
    expect(target).toHaveLength(0);
  });

  it('opens the profile it names when the caller hands it no press handler', () => {
    const renderer = renderTile({ id: PERSON_ID, username: 'ada', name: { displayName: 'Ada' } });
    const target = renderer.root.find(
      (node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function',
    );
    act(() => target.props.onPress());
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('keeps Follow outside the profile navigation target, and names it by handle', () => {
    const onFollowChange = jest.fn();
    act(() => {
      mounted = TestRenderer.create(
        <SuggestedProfileCard
          profile={{ id: PERSON_ID, username: 'ada' }}
          onFollowChange={onFollowChange}
        />,
      );
    });
    act(() => mounted!.root.findByProps({ testID: 'follow-control' }).props.onPress());
    expect(onFollowChange).toHaveBeenCalledWith(true);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockFollowButtonUsernames[mockFollowButtonUsernames.length - 1]).toBe('ada');
  });
});

it('hands the stored agent account to Bloom on search rows and suggested cards', () => {
  const profile = {
    id: 'agent',
    username: 'agent',
    kind: 'bot' as const,
    character: {
      shape: 'rounded_head_two_ears',
      eyes: 'oval',
      color: 'teal',
      eyewear: 'none',
      accessory: 'none',
    },
  };
  act(() => {
    mounted = TestRenderer.create(<ProfileCard profile={profile} />);
  });
  expect(JSON.parse(probe(mounted!, 'card-character'))).toMatchObject({
    account: profile,
    motion: 'always',
  });
  act(() => {
    mounted!.update(<SuggestedProfileCard profile={profile} />);
  });
  expect(JSON.parse(probe(mounted!, 'card-character'))).toMatchObject({
    account: profile,
    motion: 'always',
  });
});
