import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Deleting a channel: who is offered it, what they are told, and what runs in
 * which order once they say yes.
 *
 * Four properties, and a screen test is the only place any of them is
 * observable, because all four live in the wiring between a permission array,
 * a dialog and two calls to two different systems.
 *
 *   * **The affordance is a subset of the permission.** Oxy grants
 *     `account:delete` to the `owner` role alone, so an `admin` or `editor` who
 *     reaches this screen, edits the profile and flips the byline must not be
 *     offered a control the server would refuse. Both fixtures are here: a
 *     membership that holds the permission and one that holds `account:act_as`
 *     without it, which is exactly the shape a role-derived check would get
 *     wrong.
 *   * **The destructive call cannot fire without the confirmation.** A suite
 *     where the dialog always resolves `true` cannot tell "asks first" from
 *     "never asks", so the declining fixture is the load-bearing one.
 *   * **The confirmation is counted.** The count comes from the server preview,
 *     not from anything the screen already had, so the question can only be
 *     asked after that read.
 *   * **The account is archived only after Mention's half RESOLVES.** Oxy's
 *     reads exclude an archived account, and Mention's cascade resolves the
 *     account kind and username through them, so archiving first strands every
 *     post permanently. The failing-half fixture pins that the archive never
 *     happens when the content delete rejects.
 *
 * The mocks stop at module boundaries, matching `channelSettingsIdentityWrite`:
 * the SDK barrel and Bloom cannot be required under jest, and React Query is
 * real because the mutation's own sequencing is the thing under test.
 */

const mockPreview = jest.fn();
const mockDeleteContent = jest.fn();
const mockConfirmDialog = jest.fn();
const mockArchiveAccount = jest.fn();
const mockListAccounts = jest.fn();
const mockReplace = jest.fn();

jest.mock('@/services/channelDeletionService', () => ({
  channelDeletionService: {
    preview: (...args: unknown[]) => mockPreview(...args),
    deleteContent: (...args: unknown[]) => mockDeleteContent(...args),
  },
}));
jest.mock('@/utils/alerts', () => ({
  confirmDialog: (...args: unknown[]) => mockConfirmDialog(...args),
}));
jest.mock('@/lib/actorCache', () => ({ noteIdentityChanged: jest.fn() }));
jest.mock('@oxyhq/services', () => ({ clearedFieldsFromAccountUpdate: () => [] }));

jest.mock('@oxyhq/services/ui/client', () => ({
  OxyAuthPrompt: () => null,
  useAuth: () => ({
    user: { id: 'viewer-1', username: 'operator' },
    oxyServices: {
      listAccounts: (...args: unknown[]) => mockListAccounts(...args),
      updateAccount: jest.fn(),
      archiveAccount: (...args: unknown[]) => mockArchiveAccount(...args),
    },
    canUsePrivateApi: true,
    isAuthenticated: true,
    isAuthResolved: true,
    isPrivateApiPending: false,
    showBottomSheet: jest.fn(),
  }),
}));

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('@oxyhq/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ username: 'daily' }),
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
}));

/**
 * Renders the real English source of each key, with i18next's own plural
 * selection and `{{...}}` substitution reproduced for the shapes this screen
 * uses. A stand-in that echoed the key would make every assertion about WHAT
 * the operator is told vacuous, which is the half of this test that matters
 * most: the count has to reach the words, not merely the call.
 */
jest.mock('react-i18next', () => {
  const catalog = jest.requireActual<{ channels: { settings: Record<string, string> } }>(
    '../../../../../locales/en.json',
  );
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const bare = key.replace(/^channels\.settings\./, '');
        const count = typeof options?.count === 'number' ? options.count : undefined;
        const entry =
          (count === undefined
            ? undefined
            : catalog.channels.settings[`${bare}_${count === 1 ? 'one' : 'other'}`]) ??
          catalog.channels.settings[bare] ??
          (typeof options?.defaultValue === 'string' ? options.defaultValue : key);
        return entry.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
          String(options?.[name] ?? ''),
        );
      },
    }),
  };
});

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@oxyhq/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxyhq/bloom/loading', () => ({ SpinnerIcon: () => null }));
jest.mock('@oxyhq/bloom/switch', () => ({ Switch: () => null }));
jest.mock('@oxyhq/bloom/toast', () => {
  const toast = Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() });
  return { toast };
});
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#888', primary: '#00f', error: '#f00' } }),
}));
jest.mock('@oxyhq/bloom/settings-list', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SettingsListGroup: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
    // Rendered as a pressable Text carrying its own title, so the delete row can
    // be found BY that title — a stub returning null would make "the row is
    // absent" true whether the screen renders it or not.
    SettingsListItem: (props: { title: string; onPress?: () => void; disabled?: boolean }) =>
      ReactActual.createElement(
        Text,
        { testID: `settings-item:${props.title}`, onPress: props.onPress, disabled: props.disabled },
        props.title,
      ),
  };
});
jest.mock('@oxyhq/bloom/item', () => ({ Item: () => null }));

jest.mock('@/components/ThemedView', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ThemedView: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
  };
});
jest.mock('@/components/Header', () => ({ Header: () => null }));
jest.mock('@/components/ui/Button', () => ({ IconButton: () => null }));
jest.mock('@/assets/icons/back-arrow-icon', () => ({ BackArrowIcon: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/services/channelAccountService', () => ({
  channelAccountService: {
    getSettings: jest.fn().mockResolvedValue({ signPosts: false }),
    setSignPosts: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import ChannelAccountSettingsScreen from '../settings';

const CHANNEL_ID = 'channel-1';

/** The row's own title, and the only handle the test has on the affordance. */
const DELETE_ROW = 'settings-item:Delete this channel';

/** How the profile form is known to have mounted (see the sibling suite). */
const BIO_PLACEHOLDER = 'What this channel is about';

/**
 * A membership row as Oxy resolves it. `permissions` is the WIRE value: Oxy
 * derives it from the role server-side, so a fixture that carried a role and let
 * the test derive the permissions would be testing the test.
 */
function membership(permissions: string[]) {
  return {
    _id: 'member-1',
    accountId: CHANNEL_ID,
    memberUserId: 'viewer-1',
    role: 'owner',
    permissions,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function accountNode(callerMembership: ReturnType<typeof membership> | null) {
  return {
    accountId: CHANNEL_ID,
    kind: 'channel',
    parentAccountId: null,
    account: {
      id: CHANNEL_ID,
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-1',
      bio: 'bio-before',
    },
    relationship: 'owner',
    callerMembership,
  };
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    mounted = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ChannelAccountSettingsScreen />
      </QueryClientProvider>,
    );
  });
  const renderer = mounted;
  if (!renderer) throw new Error('the screen did not render');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (renderer.root.findAllByProps({ placeholder: BIO_PLACEHOLDER }).length > 0) {
      return renderer;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('the channel profile form never mounted');
}

/** Press the delete row and let the whole async flow settle. */
async function pressDelete(renderer: TestRenderer.ReactTestRenderer) {
  const row = renderer.root.findByProps({ testID: DELETE_ROW });
  await act(async () => {
    row.props.onPress();
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The single options object the screen handed to the confirmation. */
function confirmOptions(): {
  title: string;
  message: string;
  okText: string;
  destructive?: boolean;
} {
  const [options] = mockConfirmDialog.mock.calls[0] ?? [];
  if (!options) throw new Error('the confirmation was never opened');
  return options;
}

beforeEach(() => {
  mockPreview.mockReset();
  mockDeleteContent.mockReset();
  mockConfirmDialog.mockReset();
  mockArchiveAccount.mockReset();
  mockListAccounts.mockReset();
  mockReplace.mockReset();
  mockPreview.mockResolvedValue({ posts: 42, boostsByOthers: 7 });
  mockDeleteContent.mockResolvedValue({ posts: 42, boostsByOthers: 7 });
  mockArchiveAccount.mockResolvedValue({ success: true });
  mockListAccounts.mockResolvedValue([accountNode(membership(['account:delete']))]);
});

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
});

describe('who is offered the delete', () => {
  it('offers it to a member holding account:delete', async () => {
    const renderer = await renderScreen();

    // `findAllByProps` returns the composite AND its host element, so the count
    // is 2 for one row. The property is presence against the absence the next
    // three cases assert, so it is written as such rather than pinned to a
    // number the renderer decides.
    expect(renderer.root.findAllByProps({ testID: DELETE_ROW }).length).toBeGreaterThan(0);
  });

  it('withholds it from a member who may publish as the channel but not end it', async () => {
    // The exact shape a role-derived check gets wrong: an editor holds
    // `account:act_as`, so every OTHER control on this screen is rightly theirs.
    mockListAccounts.mockResolvedValue([accountNode(membership(['account:act_as']))]);
    const renderer = await renderScreen();

    expect(renderer.root.findAllByProps({ testID: DELETE_ROW })).toHaveLength(0);
    // The screen itself still rendered, so the absence above is a decision and
    // not a screen that failed to mount.
    expect(renderer.root.findByProps({ placeholder: BIO_PLACEHOLDER })).toBeTruthy();
  });

  it('withholds it when the membership carries no permissions at all', async () => {
    mockListAccounts.mockResolvedValue([accountNode(membership([]))]);
    const renderer = await renderScreen();

    expect(renderer.root.findAllByProps({ testID: DELETE_ROW })).toHaveLength(0);
  });

  it('withholds it when there is no membership row to read', async () => {
    mockListAccounts.mockResolvedValue([accountNode(null)]);
    const renderer = await renderScreen();

    expect(renderer.root.findAllByProps({ testID: DELETE_ROW })).toHaveLength(0);
  });
});

describe('the confirmation', () => {
  it('states how many posts are being destroyed, in the body and on the button', async () => {
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    const options = confirmOptions();
    expect(options.message).toContain('42 posts');
    expect(options.okText).toBe('Delete 42 posts');
    expect(options.title).toBe('Delete Daily Digest?');
    expect(options.destructive).toBe(true);
  });

  it('names the count the SERVER gave it, not one it already had', async () => {
    // The screen holds no post count of its own, so a preview that answers
    // differently is the only way to tell a real read from a hardcoded number.
    mockPreview.mockResolvedValue({ posts: 1, boostsByOthers: 0 });
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(mockPreview).toHaveBeenCalledWith(CHANNEL_ID);
    const options = confirmOptions();
    expect(options.message).toContain('1 post published by this channel');
    expect(options.okText).toBe('Delete 1 post');
  });

  it('says other people’s boosts go too, and only when some do', async () => {
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(confirmOptions().message).toContain('7 boosts of them by other people go as well');
  });

  it('omits the boost sentence when nobody boosted the channel', async () => {
    mockPreview.mockResolvedValue({ posts: 3, boostsByOthers: 0 });
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(confirmOptions().message).not.toContain('boost');
  });

  it('promises to ASK remote servers and admits it cannot make them', async () => {
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    const { message } = confirmOptions();
    expect(message).toContain('asked to remove it');
    expect(message).toContain('cannot make them');
    expect(message).toContain('archived');
  });
});

describe('what happens once the operator answers', () => {
  it('destroys NOTHING when the confirmation is declined', async () => {
    // The load-bearing fixture. With the dialog always resolving true, a screen
    // that never asked at all would pass every other test in this file.
    mockConfirmDialog.mockResolvedValue(false);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(mockConfirmDialog).toHaveBeenCalledTimes(1);
    expect(mockDeleteContent).not.toHaveBeenCalled();
    expect(mockArchiveAccount).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('deletes Mention’s half and only then archives the Oxy account', async () => {
    const order: string[] = [];
    mockDeleteContent.mockImplementation(async () => {
      order.push('mention');
      return { posts: 42, boostsByOthers: 7 };
    });
    mockArchiveAccount.mockImplementation(async () => {
      order.push('oxy');
      return { success: true };
    });
    mockConfirmDialog.mockResolvedValue(true);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(mockDeleteContent).toHaveBeenCalledWith(CHANNEL_ID);
    expect(mockArchiveAccount).toHaveBeenCalledWith(CHANNEL_ID);
    // Archive-first strands every post permanently: Oxy's reads exclude an
    // archived account, and the cascade resolves the account kind and username
    // through them. The order is the whole design.
    expect(order).toEqual(['mention', 'oxy']);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('leaves the account ALONE when Mention’s half fails', async () => {
    // The survivable failure is "posts gone, account still standing, retry
    // archives it". Archiving anyway would make it the unrecoverable one.
    mockDeleteContent.mockRejectedValue(new Error('a cascade step failed'));
    mockConfirmDialog.mockResolvedValue(true);
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(mockDeleteContent).toHaveBeenCalledTimes(1);
    expect(mockArchiveAccount).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('stays put when the preview fails, so nothing is asked or destroyed', async () => {
    mockPreview.mockRejectedValue(new Error('nope'));
    const renderer = await renderScreen();

    await pressDelete(renderer);

    expect(mockConfirmDialog).not.toHaveBeenCalled();
    expect(mockDeleteContent).not.toHaveBeenCalled();
    expect(mockArchiveAccount).not.toHaveBeenCalled();
  });
});
