import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * What a channel's profile save tells the identity door.
 *
 * This screen is the ONLY door a channel's profile has — `/edit-profile` edits
 * the signed-in user and a channel can never be signed in as — so whatever it
 * forgets to mention here is not merely late anywhere else, it is unreachable
 * until a reload. It forgot the description for as long as it has been able to
 * edit one: the save landed, `noteIdentityChanged` was called with a payload
 * that named the handle, the name and the picture, and the channel page went on
 * rendering the previous text from a React Query entry that
 * `upsertCachedUser` deliberately leaves fresh.
 *
 * Two properties, and a screen test is the only place either can be observed:
 *
 *   * The identity handed over is the ACCOUNT the server returned, not a
 *     payload assembled here. An object literal type-checks identically while
 *     omitting a field, which is exactly how this happened; handing the whole
 *     account over moves the decision to `meaningfulFields`, where it is made
 *     once.
 *   * `cleared` is derived from the write INPUT. It cannot come from the
 *     response — Oxy omits an emptied scalar exactly as it omits an untouched
 *     one — so the input is the only witness that the operator emptied
 *     something, and it exists only inside this screen.
 *
 * `noteIdentityChanged` itself is a spy: what it does with the payload belongs
 * to `lib/__tests__/actorCache.test.ts`. The mocks below stop at module
 * boundaries — the SDK barrel cannot be required under jest (untranspiled ESM),
 * and Bloom ships the same way. React Query is real, because the mutation's own
 * `onSuccess` wiring is the thing under test.
 */

const mockNoteIdentityChanged = jest.fn();
jest.mock('@/lib/actorCache', () => ({
  noteIdentityChanged: (...args: unknown[]) => mockNoteIdentityChanged(...args),
}));

/**
 * The SDK's own derivation, reproduced only for the fields this screen writes.
 * The real one lives behind the unrequirable barrel; what matters here is that
 * the screen feeds it the INPUT and forwards the answer, so a stand-in that
 * answers differently for a set and a cleared bio is enough to tell the two
 * apart — and `lib/__tests__/actorCache.test.ts` pins the forwarding contract
 * against the shape the real helper returns.
 */
jest.mock('@oxyhq/services', () => ({
  clearedFieldsFromAccountUpdate: (input: { bio?: string | null; avatar?: string | null }) => {
    const cleared: string[] = [];
    if ('bio' in input && !input.bio) cleared.push('bio');
    if ('avatar' in input && !input.avatar) cleared.push('avatar');
    return cleared;
  },
}));

const mockUpdateAccount = jest.fn();
const mockListAccounts = jest.fn();

jest.mock('@oxyhq/services/ui/client', () => ({
  OxyAuthPrompt: () => null,
  useAuth: () => ({
    user: { id: 'viewer-1', username: 'operator' },
    oxyServices: {
      listAccounts: (...args: unknown[]) => mockListAccounts(...args),
      updateAccount: (...args: unknown[]) => mockUpdateAccount(...args),
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
  router: { replace: jest.fn() },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@oxyhq/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxyhq/bloom/loading', () => ({ SpinnerIcon: () => null }));
jest.mock('@oxyhq/bloom/switch', () => ({ Switch: () => null }));
jest.mock('@oxyhq/bloom/toast', () => {
  const toast = Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() });
  return { toast };
});
jest.mock('@oxyhq/bloom/theme', () => ({ useTheme: () => ({ colors: { textSecondary: '#888' } }) }));
jest.mock('@oxyhq/bloom/settings-list', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SettingsListGroup: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
    SettingsListItem: () => null,
  };
});
jest.mock('@oxyhq/bloom/item', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Item: (props: { onPress?: () => void; disabled?: boolean; title?: string }) =>
      ReactActual.createElement(
        Text,
        { testID: 'save-profile', onPress: props.onPress, disabled: props.disabled },
        props.title ?? '',
      ),
  };
});

jest.mock('@/components/ThemedView', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { ThemedView: (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children) };
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
/**
 * The delete flow, stubbed at its two module boundaries. Neither is exercised
 * here — the fixture's `callerMembership` is `null`, so the row is not even
 * rendered — but both are imported by the screen, and the real `@/utils/alerts`
 * reaches `@oxyhq/bloom/dialog`, which cannot be required under jest.
 * `__tests__/channelDeleteChannel.test.tsx` is where the flow itself is pinned.
 */
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn().mockResolvedValue(false) }));
jest.mock('@/services/channelDeletionService', () => ({
  channelDeletionService: { preview: jest.fn(), deleteContent: jest.fn() },
}));

// eslint-disable-next-line import/first
import ChannelAccountSettingsScreen from '../settings';

const CHANNEL_ID = 'channel-1';

/**
 * How the description field is located. Its `accessibilityLabel` would read
 * better, but react-native does not surface that prop on the rendered
 * `TextInput` under this renderer, so a selector written against it finds
 * nothing whether the field is there or not.
 */
const BIO_PLACEHOLDER = 'What this channel is about';

/** The channel as the account graph holds it before any edit. */
function storedAccount() {
  return {
    id: CHANNEL_ID,
    username: 'daily',
    name: { displayName: 'Daily Digest' },
    avatar: 'avatar-1',
    bio: 'bio-before',
  };
}

/** The account node `listAccounts` returns for it. */
function accountNode() {
  return {
    accountId: CHANNEL_ID,
    kind: 'channel',
    parentAccountId: null,
    account: storedAccount(),
    relationship: {},
    callerMembership: null,
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
  // Two queries resolve in series — the operated-accounts list decides whether
  // the form mounts at all, and only then does the form ask for its byline
  // settings — so the screen sits on a spinner for more than one flush. Polling
  // for the field rather than flushing a fixed number of times keeps the wait
  // tied to what the test needs instead of to React Query's scheduling.
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

/** Type into the description field and press save. */
async function saveWithBio(renderer: TestRenderer.ReactTestRenderer, bio: string) {
  const field = renderer.root.findByProps({ placeholder: BIO_PLACEHOLDER });
  await act(async () => {
    field.props.onChangeText(bio);
  });
  const save = renderer.root.findByProps({ testID: 'save-profile' });
  await act(async () => {
    save.props.onPress();
  });
}

beforeEach(() => {
  mockNoteIdentityChanged.mockReset();
  mockUpdateAccount.mockReset();
  mockListAccounts.mockReset();
  mockListAccounts.mockResolvedValue([accountNode()]);
});

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
});

describe('saving a channel profile', () => {
  it('found the form it is about to drive', async () => {
    // The assertions below all run through one text field and one button, so a
    // screen that fell back to its operator-only or loading branch would make
    // every one of them vacuous.
    const renderer = await renderScreen();

    expect(renderer.root.findByProps({ placeholder: BIO_PLACEHOLDER })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'save-profile' })).toBeTruthy();
  });

  it('tells the identity door about a NEW description', async () => {
    const updated = { ...accountNode(), account: { ...storedAccount(), bio: 'bio-after' } };
    mockUpdateAccount.mockResolvedValue(updated);
    const renderer = await renderScreen();

    await saveWithBio(renderer, 'bio-after');

    expect(mockUpdateAccount).toHaveBeenCalledWith(
      CHANNEL_ID,
      expect.objectContaining({ bio: 'bio-after' }),
    );
    expect(mockNoteIdentityChanged).toHaveBeenCalledWith(
      updated.account,
      'viewer-1',
      { cleared: [] },
    );
  });

  it('hands over the whole account, so a field it never names still travels', async () => {
    // The regression this replaces was an object literal that listed four
    // fields and not the fifth. Anything the account carries has to arrive at
    // the door for the door to be the one place the set is decided — the
    // category list is the live proof, added to this form by a later change
    // that never had to touch the identity write at all.
    const updated = {
      ...accountNode(),
      account: {
        ...storedAccount(),
        bio: 'bio-after',
        accountCategories: ['news', 'sports'],
      },
    };
    mockUpdateAccount.mockResolvedValue(updated);
    const renderer = await renderScreen();

    await saveWithBio(renderer, 'bio-after');

    const [identity] = mockNoteIdentityChanged.mock.calls[0];
    expect(identity).toBe(updated.account);
    expect(identity).toMatchObject({ accountCategories: ['news', 'sports'] });
  });

  it('declares the clear when the operator EMPTIES the description', async () => {
    // The other direction, and a different mechanism: nothing in the response
    // distinguishes an emptied field from an untouched one, so only the input
    // this screen sent can say so.
    //
    // The fixture has to OMIT `bio`, not carry it as `undefined`, or it cannot
    // tell the two apart: oxy-api's serializer drops a cleared scalar from the
    // payload entirely, and a key that is merely `undefined` still answers
    // `'bio' in response` — which is enough to make a `cleared` wrongly derived
    // from the RESPONSE produce the right answer here and the wrong one in
    // production. Verified by mutation: with `bio: undefined` that swap passes
    // every test in this file.
    const { bio: _cleared, ...withoutBio } = storedAccount();
    const updated = { ...accountNode(), account: withoutBio };
    mockUpdateAccount.mockResolvedValue(updated);
    const renderer = await renderScreen();

    await saveWithBio(renderer, '   ');

    expect(mockUpdateAccount).toHaveBeenCalledWith(CHANNEL_ID, expect.objectContaining({ bio: null }));
    expect(mockNoteIdentityChanged).toHaveBeenCalledWith(updated.account, 'viewer-1', {
      cleared: ['bio'],
    });
  });

  it('tells no cache anything when the save fails', async () => {
    mockUpdateAccount.mockRejectedValue(new Error('nope'));
    const renderer = await renderScreen();

    await saveWithBio(renderer, 'bio-after');

    expect(mockNoteIdentityChanged).not.toHaveBeenCalled();
  });
});
