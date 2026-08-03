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

jest.mock('@oxyhq/bloom/avatar', () => {
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
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('@oxyhq/services/ui/client', () => ({ FollowButton: () => null }));
jest.mock('@oxyhq/bloom/skeleton', () => ({ Box: () => null, Group: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() },
}));
jest.mock('@oxyhq/services', () => ({
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

  it('leaves every other person alone', () => {
    const renderer = renderRow();

    act(() => {
      noteIdentityChanged({ id: 'someone-else', avatar: 'avatar-after' });
    });

    expect(probe(renderer, 'card-avatar')).toBe('avatar-before');
  });
});
