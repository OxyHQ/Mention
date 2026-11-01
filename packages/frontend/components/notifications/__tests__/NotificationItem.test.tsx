jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: true }),
}));
import type React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import {
  PostVisibility,
  type HydratedPost,
  type PostViewerState,
} from '@mention/shared-types/post';
import type { GroupedNotification } from '@/utils/groupNotifications';
import type { TRawNotification } from '@/types/validation';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { NotificationItem } from '../NotificationItem';

/**
 * The collaboration-invite notification row.
 *
 * The Accept/Decline buttons must be shown ONLY while THIS viewer's invite is
 * genuinely pending — the single source of truth is the invited post's
 * `viewerState` (derived server-side from its authorship). Once the viewer has
 * responded, the row shows a resolved label ("You accepted" / "You declined")
 * and is never actionable again. Acting also propagates the updated post to the
 * shared posts store so the feed + detail reflect the new collaboration.
 *
 * These tests seed the post-detail query the row reads and assert what the row
 * renders for each collaboration state, plus that declining propagates the
 * returned post through `postsStore.cachePosts`.
 */

const POST_ID = 'post-1';
const NOTIF_ID = 'notif-1';
const VIEWER_ID = 'viewer-1';

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' } }),
  queryKeys: { users: { detail: (id: string) => ['users', id] } },
}));

// ── Module boundaries ───────────────────────────────────────────────────────

const mockAccept = jest.fn();
const mockDecline = jest.fn();
const mockGetPostById = jest.fn();
jest.mock('@/services/feedService', () => ({
  feedService: {
    acceptCollabInvite: (...args: unknown[]) => mockAccept(...args),
    declineCollabInvite: (...args: unknown[]) => mockDecline(...args),
    getPostById: (...args: unknown[]) => mockGetPostById(...args),
  },
}));

/** The shared post cache every feed + the post detail read from (Bug B path). */
const mockCachePosts = jest.fn();
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: { cachePosts: unknown }) => unknown) =>
    selector({ cachePosts: mockCachePosts }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockPush = jest.fn();
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));

jest.mock('expo-image', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: () => <RNView /> };
});

jest.mock('@oxy.so/bloom/avatar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Avatar: () => <RNView /> };
});

jest.mock('@oxy.so/bloom/button', () => {
  const { TouchableOpacity: RNTouchable, Text: RNText } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <RNTouchable onPress={onPress} disabled={disabled} accessibilityRole="button">
        <RNText>{children}</RNText>
      </RNTouchable>
    ),
  };
});

jest.mock('@oxy.so/bloom/icons', () => ({
  RiCheckboxCircleFill: () => null,
  RiCloseCircleLine: () => null,
}));
jest.mock('@oxy.so/bloom/subtle-hover', () => ({ SubtleHover: () => null }));
// The row paints the surface it landed on. Bloom's `styles` subpath ships
// untranspiled ESM, so it is stubbed here like every other Bloom subpath in
// this file; the colour only has to be a colour.
jest.mock('@oxy.so/bloom/styles', () => ({
  useSurfaceFill: () => '#ffffff',
  tokens: { hitSlop: { md: 8 } },
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1d4ed8',
      success: '#16a34a',
      warning: '#d97706',
      error: '#dc2626',
      text: '#000000',
      textSecondary: '#666666',
      border: '#dddddd',
      background: '#ffffff',
    },
  }),
}));

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));

jest.mock('@oxy.so/services', () => ({
  queryKeys: { users: { detail: (id: string) => ['users', id] } },
}));

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
    hasPreview: true,
    actionPhrase: () => 'invited you to collaborate on a post',
  }),
}));

jest.mock('@/hooks/useCachedUser', () => ({ useUserById: () => undefined }));
jest.mock('@/utils/dateUtils', () => ({ formatRelativeTimeLocalized: () => '1h' }));
jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

const mockPresentSheet = jest.fn();
jest.mock('@/utils/sheet', () => ({
  presentSheet: (...args: unknown[]) => mockPresentSheet(...args),
}));
const mockShowActionMenu = jest.fn();
jest.mock('@/components/common/ActionMenu', () => ({
  showActionMenu: (...args: unknown[]) => mockShowActionMenu(...args),
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

function viewerState(overrides: Partial<PostViewerState>): PostViewerState {
  return {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
    ...overrides,
  };
}

const PENDING = viewerState({ collabInvitePending: true, viewerRole: 'collaborator' });
const ACCEPTED = viewerState({ isCollaborator: true, viewerRole: 'collaborator' });
const DECLINED = viewerState({ viewerRole: 'collaborator' });

function collabPost(state: PostViewerState): HydratedPost {
  return {
    id: POST_ID,
    content: { text: 'Collaboration post body' },
    attachments: {},
    user: { id: 'owner-1', username: 'owner', name: { displayName: 'Owner' } },
    authors: [],
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
    viewerState: state,
    permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

function collabInviteItem(): GroupedNotification {
  const lead: TRawNotification = {
    _id: NOTIF_ID,
    recipientId: 'viewer-1',
    actorId: 'owner-1',
    type: 'collab_invite',
    entityId: POST_ID,
    entityType: 'post',
    read: false,
    createdAt: '2026-07-16T00:00:00.000Z',
    actorId_populated: { _id: 'owner-1', username: 'owner', name: { displayName: 'Owner' } },
  };
  return {
    key: NOTIF_ID,
    type: 'collab_invite',
    entityId: POST_ID,
    entityType: 'post',
    hasUnread: true,
    createdAt: '2026-07-16T00:00:00.000Z',
    actors: [{ id: 'owner-1', name: 'Owner', username: 'owner' }],
    totalActors: 1,
    notificationIds: [NOTIF_ID],
    leadNotification: lead,
    isGroup: false,
    expandable: false,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

notifyManager.setScheduler((callback) => callback());

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];
const queryClients: QueryClient[] = [];

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) {
      renderer.unmount();
    }
  });
  for (const queryClient of queryClients.splice(0)) {
    queryClient.clear();
  }
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderRow(
  state: PostViewerState,
  options?: {
    onDelete?: jest.Mock;
    onMarkAsRead?: jest.Mock;
    item?: GroupedNotification;
    captureIntent?: () => { viewerId: string; epoch: number } | null;
    isCurrentIntent?: (intent: { viewerId: string; epoch: number }) => boolean;
  },
): Promise<{
  renderer: TestRenderer.ReactTestRenderer;
  queryClient: QueryClient;
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // Seed the post-detail query the row reads. With the row's 60s staleTime the
  // seeded (fresh) data is served synchronously and `getPostById` is never hit.
  queryClient.setQueryData(viewerQueryKeys.post(VIEWER_ID, POST_ID), collabPost(state));

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <NotificationItem
          item={options?.item ?? collabInviteItem()}
          onMarkAsRead={options?.onMarkAsRead ?? jest.fn()}
          onDelete={options?.onDelete ?? jest.fn()}
          captureIntent={options?.captureIntent ?? (() => ({ viewerId: 'viewer-1', epoch: 1 }))}
          isCurrentIntent={options?.isCurrentIntent ?? (() => true)}
        />
      </QueryClientProvider>,
    );
  });
  mountedRenderers.push(renderer);
  queryClients.push(queryClient);
  await flush();
  return { renderer, queryClient };
}

function texts(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .flatMap((node) => {
      const children = node.props.children;
      return Array.isArray(children) ? children : [children];
    })
    .filter((child): child is string => typeof child === 'string')
    .map((child) => child.trim());
}

function buttonByLabel(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return root.findAll((node) => {
    if (node.type !== TouchableOpacity) return false;
    const labels = node
      .findAllByType(Text)
      .flatMap((n) => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]));
    return labels.includes(label);
  })[0];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('NotificationItem — collaboration invite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not mark or navigate from a row owned by an earlier session', async () => {
    let epoch = 1;
    const original = { viewerId: VIEWER_ID, epoch };
    const onMarkAsRead = jest.fn();
    const { renderer } = await renderRow(PENDING, {
      onMarkAsRead,
      captureIntent: () => original,
      isCurrentIntent: (intent) => intent.epoch === epoch,
    });
    const target = renderer.root.findAll((node) => typeof node.props.onLongPress === 'function')[0];
    epoch = 3;
    act(() => target.props.onPress());
    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('rechecks the row session after marking and before navigation', async () => {
    let epoch = 1;
    const original = { viewerId: VIEWER_ID, epoch };
    const onMarkAsRead = jest.fn(() => {
      epoch = 2;
    });
    const { renderer } = await renderRow(PENDING, {
      onMarkAsRead,
      captureIntent: () => original,
      isCurrentIntent: (intent) => intent.epoch === epoch,
    });
    const target = renderer.root.findAll((node) => typeof node.props.onLongPress === 'function')[0];
    act(() => target.props.onPress());
    expect(onMarkAsRead).toHaveBeenCalledWith([NOTIF_ID], original);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('marks and navigates when the row session remains current', async () => {
    const onMarkAsRead = jest.fn();
    const { renderer } = await renderRow(PENDING, { onMarkAsRead });
    const target = renderer.root.findAll((node) => typeof node.props.onLongPress === 'function')[0];
    act(() => target.props.onPress());
    expect(onMarkAsRead).toHaveBeenCalledWith([NOTIF_ID], { viewerId: VIEWER_ID, epoch: 1 });
    expect(mockPush).toHaveBeenCalledWith(`/p/${POST_ID}`);
  });

  it('blocks stale profile navigation from an expanded group', async () => {
    let epoch = 1;
    const original = { viewerId: VIEWER_ID, epoch };
    const item = {
      ...collabInviteItem(),
      isGroup: true,
      expandable: true,
      totalActors: 2,
      actors: [
        { id: 'owner-1', name: 'Owner', username: 'owner' },
        { id: 'other-1', name: 'Other', username: 'other' },
      ],
    };
    const { renderer } = await renderRow(PENDING, {
      item,
      captureIntent: () => original,
      isCurrentIntent: (intent) => intent.epoch === epoch,
    });
    const expand = renderer.root
      .findAll(
        (node) =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function' &&
          node.findAllByType(Text).some((text) => text.props.children === 'Show all'),
      )
      .at(-1);
    expect(expand).toBeDefined();
    act(() => expand?.props.onPress());
    const profile = renderer.root.findAll(
      (node) =>
        node.props.className === 'flex-row items-center gap-2' &&
        typeof node.props.onPress === 'function',
    )[0];
    expect(profile).toBeDefined();
    act(() => profile.props.onPress());
    expect(mockPush).toHaveBeenCalledTimes(1);
    mockPush.mockClear();
    epoch = 3;
    act(() => profile.props.onPress());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('captures the original intent when the action menu opens, not when a row is pressed', async () => {
    let epoch = 1;
    const onDelete = jest.fn();
    const { renderer } = await renderRow(PENDING, {
      onDelete,
      captureIntent: () => ({ viewerId: 'viewer-1', epoch }),
    });
    const target = renderer.root.findAll((node) => typeof node.props.onLongPress === 'function')[0];
    expect(target).toBeDefined();
    act(() => target.props.onLongPress());
    const menu = mockShowActionMenu.mock.calls[0][0] as {
      groups: { onPress: () => void; label: string }[][];
    };
    epoch = 3;
    const action = menu.groups.flat().find((item) => item.label === 'Delete');
    expect(action).toBeDefined();
    act(() => action?.onPress());
    expect(onDelete).toHaveBeenCalledWith([NOTIF_ID], { viewerId: 'viewer-1', epoch: 1 });
  });

  it('does not submit a collaboration sheet opened in an earlier session', async () => {
    let epoch = 1;
    const { renderer } = await renderRow(PENDING, {
      captureIntent: () => ({ viewerId: VIEWER_ID, epoch }),
      isCurrentIntent: (intent) => intent.epoch === epoch,
    });
    const accept = buttonByLabel(renderer.root, 'Accept');
    await act(async () => {
      accept?.props.onPress();
    });
    const createSheet = mockPresentSheet.mock.calls[0][0] as (surface: { dismiss: () => void }) => {
      props: { onAccept: () => Promise<void> };
    };
    const dismiss = jest.fn();
    const sheet = createSheet({ dismiss });
    epoch = 3;
    await act(async () => {
      await sheet.props.onAccept();
    });
    expect(mockAccept).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalled();
  });

  it('does not update the post cache when a decline resolves after a session change', async () => {
    let epoch = 1;
    let resolve!: (value: { success: boolean; post: HydratedPost }) => void;
    mockDecline.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { renderer } = await renderRow(PENDING, {
      captureIntent: () => ({ viewerId: VIEWER_ID, epoch }),
      isCurrentIntent: (intent) => intent.epoch === epoch,
    });
    const decline = buttonByLabel(renderer.root, 'Decline');
    await act(async () => {
      decline?.props.onPress();
    });
    expect(mockDecline).toHaveBeenCalledWith(POST_ID, VIEWER_ID);
    epoch = 2;
    await act(async () => {
      resolve({ success: true, post: collabPost(DECLINED) });
      await Promise.resolve();
    });
    expect(mockCachePosts).not.toHaveBeenCalled();
  });

  it('does not treat an unsuccessful collaboration reply as success', async () => {
    mockDecline.mockResolvedValue({ success: false, post: collabPost(DECLINED) });
    const { renderer } = await renderRow(PENDING);
    const decline = buttonByLabel(renderer.root, 'Decline');
    await act(async () => {
      decline?.props.onPress();
    });
    await flush();
    expect(mockCachePosts).not.toHaveBeenCalled();
    expect(texts(renderer.root)).toContain('Decline');
  });

  it('shows Accept/Decline while the invite is pending, with no resolved label', async () => {
    const { renderer } = await renderRow(PENDING);
    const rendered = texts(renderer.root);

    expect(rendered).toContain('Accept');
    expect(rendered).toContain('Decline');
    expect(rendered).not.toContain('You accepted');
    expect(rendered).not.toContain('You declined');
  });

  it('hides the buttons and shows "You accepted" once the viewer is a collaborator', async () => {
    const { renderer } = await renderRow(ACCEPTED);
    const rendered = texts(renderer.root);

    expect(rendered).toContain('You accepted');
    expect(rendered).not.toContain('Accept');
    expect(rendered).not.toContain('Decline');
  });

  it('hides the buttons and shows "You declined" once the viewer has declined', async () => {
    const { renderer } = await renderRow(DECLINED);
    const rendered = texts(renderer.root);

    expect(rendered).toContain('You declined');
    expect(rendered).not.toContain('Accept');
    expect(rendered).not.toContain('Decline');
  });

  it('declining propagates the returned post to the shared store and flips the row to resolved', async () => {
    mockDecline.mockResolvedValue({ success: true, post: collabPost(DECLINED) });

    const { renderer } = await renderRow(PENDING);
    const declineButton = buttonByLabel(renderer.root, 'Decline');
    expect(declineButton).toBeDefined();

    await act(async () => {
      declineButton?.props.onPress();
    });
    await flush();

    // The mutation ran, and its returned post was pushed into the shared cache
    // (the same mechanism post edits/deletes use to refresh feed + detail).
    expect(mockDecline).toHaveBeenCalledWith(POST_ID, VIEWER_ID);
    expect(mockCachePosts).toHaveBeenCalledWith([collabPost(DECLINED)]);

    // The row is now resolved — no longer actionable.
    const rendered = texts(renderer.root);
    expect(rendered).toContain('You declined');
    expect(rendered).not.toContain('Decline');
  });
});
