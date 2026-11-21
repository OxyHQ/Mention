import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { GroupedNotification } from '@/utils/groupNotifications';
import type { TRawNotification } from '@/types/validation';

/**
 * A grouped notification names several people, and all of them follow a profile
 * edit — not just the first.
 *
 * The row once resolved only `actors[0]` reactively; every OTHER actor was a
 * non-reactive cache read inside a memo keyed on the primary, so editing a
 * grouped actor who is not first changed nothing that memo watched and the row
 * kept the picture the notification arrived with. Every actor now reads the
 * person the Oxy SDK's `User` holds (`data/users`), each subscribed by id.
 *
 * Each test starts from an empty store: nobody is held until the edit, the case
 * of a grouped actor the screen never prewarmed.
 */

// Keep the renderer boundary isolated; the account policy has its own contract tests.
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
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: false }),
}));

// The SDK's per-person read, which the row calls to ask Oxy for a primary
// nobody holds. A `jest.fn` so a test can read whom the row asked about.
const mockUseUserById = jest.fn((_id: string | null) => ({ data: undefined }));
jest.mock('@oxy.so/services/ui/client', () => ({
  ...jest.requireActual('@/test-support/oxyUsers'),
  useAuth: () => ({ user: { id: 'viewer-1' } }),
  useUserById: (id: string | null) => mockUseUserById(id),
}));
jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: unknown) => unknown) => selector({ cachePosts: jest.fn() }),
}));
jest.mock('@/hooks/useStorePost', () => ({ useStorePost: () => null }));
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
jest.mock('@oxy.so/bloom/avatar', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Avatar: ({ source }: { source?: string | null }) => (
      <RNText testID="strip-avatar">{source ?? ''}</RNText>
    ),
  };
});
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/icons', () => ({
  RiCheckboxCircleFill: () => null,
  RiCloseCircleLine: () => null,
}));
jest.mock('@oxy.so/bloom/subtle-hover', () => ({ SubtleHover: () => null }));
// The row paints the surface it landed on. Bloom's `styles` subpath ships
// untranspiled ESM, so it is stubbed here like every other Bloom subpath in
// this file; the colour only has to be a colour.
jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => '#ffffff' }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666', primary: '#000', border: '#eee' } }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/core', () => ({
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
jest.mock('@/components/AccountBadge', () => ({ AccountBadge: () => null }));
jest.mock('@/components/Compose/CollabAcceptSheet', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../notificationDescriptors', () => ({
  getDescriptor: () => ({
    icon: () => null,
    colorToken: 'primary',
    actionPhrase: () => 'liked your post',
  }),
}));
jest.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn(), presentCancelableSheet: jest.fn() }));
jest.mock('@/components/common/ActionMenu', () => ({
  showActionMenu: jest.fn(),
  showCancelableActionMenu: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() },
}));

import { NotificationItem } from '../NotificationItem';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { storeUsers } from '@oxy.so/services/ui/client';

/** An accepted profile write, as the SDK stores Oxy's answer in `User`. */
function edit(person: { id: string; [field: string]: unknown }): void {
  storeUsers({ ...person, updatedAt: '2026-08-04T00:00:00.000Z' });
}

beforeEach(() => {
  setActiveStore(new Store());
});

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

function renderRow(item: GroupedNotification = groupedLike()) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    mounted = TestRenderer.create(
      <QueryClientProvider client={queryClient as QueryClient}>
        <NotificationItem
          item={item}
          onMarkAsRead={jest.fn()}
          onDelete={jest.fn()}
          captureIntent={() => ({ viewerId: 'viewer-1', epoch: 1 })}
          isCurrentIntent={() => true}
          ownNotificationSurface={async (_intent, present) =>
            present(new AbortController().signal, () => {})
          }
        />
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
      edit({ id: SECONDARY_ID, avatar: 'secondary-after' });
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
      edit({ id: PRIMARY_ID, avatar: 'primary-after' });
    });

    const avatars = stripAvatars(renderer);
    expect(avatars).toEqual(expect.arrayContaining(['primary-after']));
    expect(avatars).not.toEqual(expect.arrayContaining(['primary-before']));
  });

  it('leaves a row alone when somebody else is edited', () => {
    const renderer = renderRow();

    act(() => {
      edit({ id: 'nobody-here', avatar: 'x' });
    });

    expect(stripAvatars(renderer)).toEqual(
      expect.arrayContaining(['primary-before', 'secondary-before']),
    );
  });
});

/**
 * The row reads the user cache only for an actor whose id an Oxy lookup could
 * resolve, so that a placeholder id never fires a stray per-row request. That
 * gate was a 24-hex ObjectId test, and Oxy has minted uuid v7 since its
 * 2026-07-31 cutover — so for every account created after that date the row
 * asked about NOBODY and kept whatever name and avatar the notification arrived
 * with, permanently. The bug is invisible from the outside (the fallback renders
 * fine), which is why the assertion is on the id the row asks about.
 */
describe('the actor whose profile the row resolves', () => {
  const asked = () => mockUseUserById.mock.calls.map((call) => call[0]);

  it('does not look up the synthetic system actor and still resolves a real actor after reuse', () => {
    const system = groupedLike();
    system.actors[0] = { id: 'system', name: 'System', username: 'system' };
    system.isGroup = false;
    system.actors = [system.actors[0]];

    const renderer = renderRow(system);
    expect(asked().at(-1)).toBeNull();
    expect(JSON.stringify(renderer.toJSON())).toContain('System');

    const actual = groupedLike();
    act(() => {
      renderer.update(
        <QueryClientProvider client={queryClient as QueryClient}>
          <NotificationItem
            item={actual}
            onMarkAsRead={jest.fn()}
            onDelete={jest.fn()}
            captureIntent={() => ({ viewerId: 'viewer-1', epoch: 1 })}
            isCurrentIntent={() => true}
            ownNotificationSurface={async (_intent, present) =>
              present(new AbortController().signal, () => {})
            }
          />
        </QueryClientProvider>,
      );
    });
    expect(asked().at(-1)).toBe(PRIMARY_ID);

    act(() => {
      renderer.update(
        <QueryClientProvider client={queryClient as QueryClient}>
          <NotificationItem
            item={system}
            onMarkAsRead={jest.fn()}
            onDelete={jest.fn()}
            captureIntent={() => ({ viewerId: 'viewer-1', epoch: 1 })}
            isCurrentIntent={() => true}
            ownNotificationSurface={async (_intent, present) =>
              present(new AbortController().signal, () => {})
            }
          />
        </QueryClientProvider>,
      );
    });
    expect(asked().at(-1)).toBeNull();
    expect(JSON.stringify(renderer.toJSON())).toContain('System');
  });

  it('asks about a uuid v7 actor id', () => {
    const uuidActor = '01a0821e-d61a-7a78-b5d1-afb1850bd5a4';
    const item = groupedLike();
    item.actors[0].id = uuidActor;

    renderRow(item);

    expect(asked()).toContain(uuidActor);
  });

  it('asks about a legacy 24-hex actor id', () => {
    const hexActor = '65fdc8c8c8c8c8c8c8c8c8c8';
    const item = groupedLike();
    item.actors[0].id = hexActor;

    renderRow(item);

    expect(asked()).toContain(hexActor);
  });

  it('asks about an id of no particular shape, because shape is not the question', () => {
    renderRow();

    expect(asked()).toContain(PRIMARY_ID);
  });

  it('asks about nobody when the actor carries no id at all', () => {
    const item = groupedLike();
    delete (item.actors[0] as { id?: string }).id;

    renderRow(item);

    expect(asked().every((id) => id === null)).toBe(true);
  });

  it('does not ask Oxy about a primary the store already holds', () => {
    edit({ id: PRIMARY_ID, username: 'primary', avatar: 'primary-held' });

    const renderer = renderRow();

    expect(asked().every((id) => id === null)).toBe(true);
    expect(stripAvatars(renderer)).toEqual(expect.arrayContaining(['primary-held']));
  });
});
