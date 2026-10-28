jest.mock('@/components/Commerce/StorefrontSettings', () => ({ StorefrontSettings: () => null }));
jest.mock('@oxy.so/bloom/skeleton', () => require('@/test-support/bloomSkeleton'));
import TestRenderer, { act } from 'react-test-renderer';
import { StorefrontSettings } from '@/components/Commerce/StorefrontSettings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * What Mention hands Oxy's `AccountSettings` for a member-operated account.
 * The form, the permissions and the archive's order are Oxy's (and tested
 * there); what is Mention's is the wiring, so the SDK screen is a stub that
 * records its props and the test drives them:
 *
 *   * a channel's deletion is COUNTED — the count is the server preview's, in
 *     the body and on the button — and its posts go in `beforeArchive`, which
 *     Oxy runs before the archive and which stops it when it rejects;
 *   * a community is Oxy's archive alone, with nothing of Mention's before it;
 *   * every accepted profile write reaches Mention's own identity caches.
 */

const mockPreview = jest.fn();
const mockDeleteContent = jest.fn();
const mockConfirmDialog = jest.fn();
const mockListAccounts = jest.fn();
const mockReplace = jest.fn();
const mockNoteIdentityChanged = jest.fn();
const mockAccountSettings = jest.fn();

jest.mock('@/services/channelDeletionService', () => ({
  channelDeletionService: {
    preview: (...args: unknown[]) => mockPreview(...args),
    deleteContent: (...args: unknown[]) => mockDeleteContent(...args),
  },
}));
jest.mock('@/utils/alerts', () => ({
  confirmDialog: (...args: unknown[]) => mockConfirmDialog(...args),
}));
jest.mock('@/lib/actorCache', () => ({
  noteIdentityChanged: (...args: unknown[]) => mockNoteIdentityChanged(...args),
}));
jest.mock('@oxy.so/services/screens', () => ({
  AccountSettings: (props: unknown) => {
    mockAccountSettings(props);
    return null;
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  OxyAuthPrompt: () => null,
  useAuth: () => ({
    user: { id: 'viewer-1', username: 'operator' },
    oxyServices: { accounts: { list: (...args: unknown[]) => mockListAccounts(...args) } },
    canUsePrivateApi: true,
    isAuthenticated: true,
    isAuthResolved: true,
    isPrivateApiPending: false,
  }),
}));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('expo-router', () => ({
  useRouter: () => jest.requireMock('expo-router').router,
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  Screen: ({ children }: { children: unknown }) => children,
  ScreenScrollView: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../ChannelBylineSettings', () => ({ ChannelBylineSettings: () => null }));
jest.mock('../CommunityModerationSettings', () => ({ CommunityModerationSettings: () => null }));

/**
 * Renders the real English source of each key, with i18next's own plural
 * selection and `{{...}}` substitution reproduced for the shapes this screen
 * uses. A stand-in that echoed the key would make every assertion about WHAT
 * the operator is told vacuous, which is the half of this test that matters
 * most: the count has to reach the words, not merely the call.
 */
jest.mock('react-i18next', () => {
  const catalog = jest.requireActual<Record<string, unknown>>('@/locales/en.json');
  // A flat key wins over a nested path, as in i18next's own resolution.
  const lookup = (key: string): string | undefined => {
    const flat = catalog[key];
    if (typeof flat === 'string') return flat;
    const nested = key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        catalog,
      );
    return typeof nested === 'string' ? nested : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const count = typeof options?.count === 'number' ? options.count : undefined;
        const entry =
          (count === undefined ? undefined : lookup(`${key}_${count === 1 ? 'one' : 'other'}`)) ??
          lookup(key) ??
          key;
        return entry.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
          String(options?.[name] ?? ''),
        );
      },
    }),
  };
});

import { ChannelBylineSettings } from '../ChannelBylineSettings';
import { CommunityModerationSettings } from '../CommunityModerationSettings';
import {
  type OperatedAccountKind,
  OperatedAccountSettingsScreen,
} from '../OperatedAccountSettingsScreen';

const ACCOUNT_ID = 'account-1';

function accountNode(kind: OperatedAccountKind) {
  return {
    accountId: ACCOUNT_ID,
    kind,
    parentAccountId: null,
    account: { id: ACCOUNT_ID, username: 'daily', name: { displayName: 'Daily Digest' } },
    relationship: 'member',
    callerMembership: null,
  };
}

interface RecordedProps {
  accountId: string;
  extraSections: { props: { children: { type: unknown; props: { accountId: string } }[] } };
  onUpdated: (account: unknown, change: { cleared: string[] }) => void;
  archive: {
    title?: string;
    confirm?: (node: unknown) => Promise<boolean>;
    beforeArchive?: (node: unknown) => Promise<void>;
    onArchived: (node: unknown) => void;
  };
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

/** Renders the route and returns the props the embedded Oxy settings received. */
async function renderSettings(kind: OperatedAccountKind): Promise<RecordedProps> {
  mockListAccounts.mockResolvedValue([accountNode(kind)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    mounted = TestRenderer.create(
      <QueryClientProvider client={client}>
        <OperatedAccountSettingsScreen kind={kind} handle="daily" />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 20 && mockAccountSettings.mock.calls.length === 0; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const props = mockAccountSettings.mock.calls.at(-1)?.[0] as RecordedProps | undefined;
  if (!props) throw new Error('the Oxy settings never mounted');
  return props;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreview.mockResolvedValue({ posts: 42, boostsByOthers: 7 });
  mockDeleteContent.mockResolvedValue({ posts: 42, boostsByOthers: 7 });
});

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
});

describe('a channel', () => {
  it('asks a counted question, with the count the server gave', async () => {
    mockConfirmDialog.mockResolvedValue(false);
    const { archive, accountId, extraSections } = await renderSettings('channel');

    expect(accountId).toBe(ACCOUNT_ID);
    expect(
      extraSections.props.children.map((section) => [section.type, section.props.accountId]),
    ).toEqual([
      [StorefrontSettings, ACCOUNT_ID],
      [ChannelBylineSettings, ACCOUNT_ID],
    ]);
    expect(archive.title).toBe('Delete this channel');
    await expect(archive.confirm?.(accountNode('channel'))).resolves.toBe(false);

    expect(mockPreview).toHaveBeenCalledWith(ACCOUNT_ID);
    const [options] = mockConfirmDialog.mock.calls[0];
    expect(options.title).toBe('Delete Daily Digest?');
    expect(options.message).toContain('42 posts');
    expect(options.message).toContain('7 boosts of them by other people go as well');
    expect(options.message).toContain('cannot make them');
    expect(options.okText).toBe('Delete 42 posts');
    expect(options.destructive).toBe(true);
    // Answering is all the question does: Oxy runs the archive steps only on a yes.
    expect(mockDeleteContent).not.toHaveBeenCalled();
  });

  it('deletes its posts before the archive, then leaves its page', async () => {
    const { archive } = await renderSettings('channel');

    await archive.beforeArchive?.(accountNode('channel'));
    expect(mockDeleteContent).toHaveBeenCalledWith(ACCOUNT_ID);

    mockDeleteContent.mockRejectedValueOnce(new Error('a cascade step failed'));
    // The rejection reaches Oxy, which then archives nothing.
    await expect(archive.beforeArchive?.(accountNode('channel'))).rejects.toThrow();

    act(() => archive.onArchived(accountNode('channel')));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('tells Mention’s identity caches about every profile write', async () => {
    const { onUpdated } = await renderSettings('channel');
    const account = { id: ACCOUNT_ID, username: 'daily', bio: undefined };

    onUpdated(account, { cleared: ['bio'] });

    expect(mockNoteIdentityChanged).toHaveBeenCalledWith(account, 'viewer-1', { cleared: ['bio'] });
  });
});

describe('a community', () => {
  it('is archived by Oxy alone, and links its bans', async () => {
    const { archive, extraSections } = await renderSettings('community');

    expect(
      extraSections.props.children.map((section) => [section.type, section.props.accountId]),
    ).toEqual([
      [StorefrontSettings, ACCOUNT_ID],
      [CommunityModerationSettings, ACCOUNT_ID],
    ]);
    expect(archive.confirm).toBeUndefined();
    expect(archive.beforeArchive).toBeUndefined();
    act(() => archive.onArchived(accountNode('community')));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
