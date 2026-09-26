import React from 'react';
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
 * it did on a post row. Resolving it in the row is what reaches all fifteen; a
 * correction per surface is fifteen chances to forget one.
 *
 * The mocks below exist only to keep untransformed ESM out of the module graph,
 * the same reason `PostDetailStats.test.tsx` mocks its Bloom subpaths. `Avatar`
 * and `UserName` are the two that carry the answer, so they are stand-ins that
 * report what they were handed rather than `null`.
 */

jest.mock('@oxy.so/bloom/chat-people', () => {
  const { View, TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    ContactRow: ({ avatarSlot, identitySlot, onPress }: { avatarSlot: React.ReactNode; identitySlot: React.ReactNode; onPress?: () => void }) =>
      onPress ? ReactActual.createElement(TouchableOpacity, { onPress }, avatarSlot, identitySlot) : ReactActual.createElement(View, null, avatarSlot, identitySlot),
  };
});
jest.mock('@oxy.so/bloom/avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    Avatar: (props: { source?: string | null }) =>
      ReactActual.createElement(Text, { testID: 'card-avatar' }, props.source ?? ''),
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
  return { FollowButton: ({ onFollowChange, username }: { onFollowChange?: (next: boolean) => void; username?: string }) => {
    mockFollowButtonUsernames.push(username);
    return ReactActual.createElement(TouchableOpacity, { testID: 'follow-control', onPress: () => onFollowChange?.(true) });
  } };
});
jest.mock('@oxy.so/bloom/typography', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Text };
});
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: () => null, Group: () => null }));
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
jest.mock('@oxy.so/services', () => ({
  upsertCachedUser: jest.fn(),
  upsertCachedUsers: jest.fn(),
}));
jest.mock('@/utils/userPlaceholderColor', () => ({
  getUserPlaceholderColor: () => '#888888',
}));

// eslint-disable-next-line import/first
import { ProfileCard } from '@/components/ProfileCard';
// eslint-disable-next-line import/first
import { noteIdentityChanged } from '@/lib/actorCache';
// eslint-disable-next-line import/first
import { resetIdentityUpdates } from '@/stores/identityUpdates';

const PERSON_ID = 'person-1';

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
  resetIdentityUpdates();
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
      noteIdentityChanged({
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
      noteIdentityChanged({ id: PERSON_ID, username: 'ada-l' });
    });

    // Not cosmetic: the handle is what the row navigates to, so a stale one is a
    // tap that 404s.
    expect(probe(renderer, 'card-name')).toBe('Ada|ada-l');
  });

  it('keeps the follow control outside the profile navigation target', () => {
    const onFollowChange = jest.fn();
    act(() => {
      mounted = TestRenderer.create(<ProfileCard profile={{ id: PERSON_ID, username: 'ada' }}
        size="small" horizontalInset={0} showFollowButton onFollowChange={onFollowChange} />);
    });
    const follow = mounted!.root.findByProps({ testID: 'follow-control' });
    act(() => follow.props.onPress());
    expect(onFollowChange).toHaveBeenCalledWith(true);
    expect(mockPush).not.toHaveBeenCalled();
    // The navigation ContactRow and FollowButton are siblings: even platforms
    // that bubble press events cannot deliver this press to the row.
    const row = mounted!.root.findByType(require('@oxy.so/bloom/chat-people').ContactRow);
    expect(row.findAllByProps({ testID: 'follow-control' })).toHaveLength(0);
    act(() => row.props.onPress());
    expect(mockPush).toHaveBeenCalled();
  });

  it('leaves every other person alone', () => {
    const renderer = renderRow();

    act(() => {
      noteIdentityChanged({ id: 'someone-else', avatar: 'avatar-after' });
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
