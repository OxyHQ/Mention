import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { GroupedNotification } from '@/utils/groupNotifications';
import type { TRawNotification } from '@/types/validation';

/**
 * A grouped notification names several people, and all of them follow a profile
 * edit — not just the first.
 *
 * The row resolves `actors[0]` reactively through the user cache, so the primary
 * was always going to pick an edit up. Every OTHER actor is resolved by a
 * non-reactive `getQueryData` read inside a memo keyed on the primary, so
 * editing a grouped actor who is not first changed nothing that memo watches and
 * the row kept the picture the notification arrived with.
 *
 * These deliberately give the row NO cache entry for anybody. That is the
 * sharper case: it proves the overlay itself carries the correction rather than
 * the row happening to re-read a cache somebody else had already fixed, and it
 * is real — a grouped actor the screen never prewarmed has no entry to read.
 */

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' } }),
}));
jest.mock('@/services/feedService', () => ({ feedService: { getPostById: jest.fn() } }));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: unknown) => unknown) =>
    selector({ cachePosts: jest.fn() }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-image', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: () => <RNView /> };
});

/** Reports the source it was handed, so the assertion reads the real value. */
jest.mock('@oxyhq/bloom/avatar', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Avatar: ({ source }: { source?: string | null }) => (
      <RNText testID="strip-avatar">{source ?? ''}</RNText>
    ),
  };
});
jest.mock('@oxyhq/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxyhq/bloom/subtle-hover', () => ({ SubtleHover: () => null }));
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666', primary: '#000', border: '#eee' } }),
}));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxyhq/services', () => ({
  queryKeys: { users: { detail: (id: string) => ['users', id] } },
  upsertCachedUser: jest.fn(),
  upsertCachedUsers: jest.fn(),
}));
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user?: { username?: string | null } | null): string | null => {
    const username = (user?.username ?? '').trim().replace(/^@/, '');
    return username.length > 0 ? username : null;
  },
}));
jest.mock('@/components/UserName', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: ({ name }: { name?: string }) => <RNText>{name}</RNText> };
});
jest.mock('@/components/common/LinkifiedText', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { LinkifiedText: ({ text }: { text?: string }) => <RNText>{text}</RNText> };
});
jest.mock('@/components/Fediverse/FediverseBadge', () => ({ RemoteActorBadge: () => null }));
jest.mock('@/components/Compose/CollabAcceptSheet', () => ({ __esModule: true, default: () => null }));
jest.mock('@/assets/icons/done-all-icon', () => ({ DoneAllIcon: () => null }));
jest.mock('@/assets/icons/trash-icon', () => ({ TrashIcon: () => null }));
jest.mock('../notificationDescriptors', () => ({
  getDescriptor: () => ({
    icon: 'heart',
    colorToken: 'primary',
    actionPhrase: () => 'liked your post',
  }),
}));
jest.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));
jest.mock('@/context/BottomSheetContext', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    BottomSheetContext: ReactActual.createContext({
      openBottomSheet: jest.fn(),
      setBottomSheetContent: jest.fn(),
    }),
  };
});
jest.mock('@oxyhq/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
// Nobody is in the user cache: the overlay alone has to carry the correction.
jest.mock('@/hooks/useCachedUser', () => ({ useUserById: () => undefined }));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() },
}));

// eslint-disable-next-line import/first
import { NotificationItem } from '../NotificationItem';
// eslint-disable-next-line import/first
import { noteIdentityChanged } from '@/lib/actorCache';
// eslint-disable-next-line import/first
import { resetIdentityUpdates } from '@/stores/identityUpdates';

const PRIMARY_ID = 'actor-primary';
const SECONDARY_ID = 'actor-secondary';

notifyManager.setScheduler((callback) => callback());

function groupedLike(): GroupedNotification {
  const lead = {
    _id: 'notif-1',
    recipientId: 'viewer-1',
    actorId: PRIMARY_ID,
    type: 'like',
    entityId: 'post-1',
    entityType: 'post',
    read: false,
    createdAt: '2026-08-03T00:00:00.000Z',
  } as unknown as TRawNotification;

  return {
    key: 'notif-1',
    type: 'like',
    entityId: 'post-1',
    entityType: 'post',
    hasUnread: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    actors: [
      { id: PRIMARY_ID, name: 'Primary', username: 'primary', avatar: 'primary-before' },
      { id: SECONDARY_ID, name: 'Secondary', username: 'secondary', avatar: 'secondary-before' },
    ],
    totalActors: 2,
    notificationIds: ['notif-1'],
    leadNotification: lead,
    isGroup: true,
    expandable: false,
  } as unknown as GroupedNotification;
}

let mounted: TestRenderer.ReactTestRenderer | null = null;
let queryClient: QueryClient | null = null;

function renderRow() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    mounted = TestRenderer.create(
      <QueryClientProvider client={queryClient as QueryClient}>
        <NotificationItem item={groupedLike()} onMarkAsRead={jest.fn()} onDelete={jest.fn()} />
      </QueryClientProvider>,
    );
  });
  if (!mounted) throw new Error('the row did not render');
  return mounted;
}

/** Every avatar in the collapsed strip, in render order. */
function stripAvatars(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByProps({ testID: 'strip-avatar' })
    .map((node) => String(node.props.children));
}

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
  queryClient?.clear();
  queryClient = null;
  resetIdentityUpdates();
  jest.clearAllMocks();
});

describe('a grouped notification follows every actor it names', () => {
  it('starts from the actors the notification arrived with', () => {
    const renderer = renderRow();
    // The positive control for the two assertions below: without it, a strip
    // that rendered nothing would make them pass by finding nothing to disagree.
    expect(stripAvatars(renderer)).toEqual(
      expect.arrayContaining(['primary-before', 'secondary-before']),
    );
  });

  it('repaints a NON-PRIMARY actor when their profile is edited', () => {
    const renderer = renderRow();

    act(() => {
      noteIdentityChanged({ id: SECONDARY_ID, avatar: 'secondary-after' });
    });

    const avatars = stripAvatars(renderer);
    expect(avatars).toEqual(expect.arrayContaining(['secondary-after']));
    expect(avatars).not.toEqual(expect.arrayContaining(['secondary-before']));
    // and the primary is untouched
    expect(avatars).toEqual(expect.arrayContaining(['primary-before']));
  });

  it('repaints the primary actor too', () => {
    const renderer = renderRow();

    act(() => {
      noteIdentityChanged({ id: PRIMARY_ID, avatar: 'primary-after' });
    });

    const avatars = stripAvatars(renderer);
    expect(avatars).toEqual(expect.arrayContaining(['primary-after']));
    expect(avatars).not.toEqual(expect.arrayContaining(['primary-before']));
  });

  it('leaves a row alone when somebody else is edited', () => {
    const renderer = renderRow();

    act(() => {
      noteIdentityChanged({ id: 'nobody-here', avatar: 'x' });
    });

    expect(stripAvatars(renderer)).toEqual(
      expect.arrayContaining(['primary-before', 'secondary-before']),
    );
  });
});
