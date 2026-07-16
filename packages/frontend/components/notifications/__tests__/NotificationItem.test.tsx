import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { PostVisibility, type HydratedPost, type PostViewerState } from '@mention/shared-types';
import type { GroupedNotification } from '@/utils/groupNotifications';
import type { TRawNotification } from '@/types/validation';
import { queryKeys } from '@/hooks/useOptimizedQuery';

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

jest.mock('expo-image', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: () => <RNView /> };
});

jest.mock('@expo/vector-icons', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Ionicons: () => <RNView /> };
});

jest.mock('@oxyhq/bloom/avatar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Avatar: () => <RNView /> };
});

jest.mock('@oxyhq/bloom/button', () => {
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

jest.mock('@oxyhq/bloom/subtle-hover', () => ({ SubtleHover: () => null }));

jest.mock('@oxyhq/bloom/theme', () => ({
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

jest.mock('@oxyhq/bloom/toast', () => ({ show: jest.fn() }));

jest.mock('@oxyhq/services', () => ({
  queryKeys: { users: { detail: (id: string) => ['users', id] } },
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
    icon: 'people',
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

jest.mock('@/context/BottomSheetContext', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    BottomSheetContext: ReactActual.createContext({
      openBottomSheet: jest.fn(),
      setBottomSheetContent: jest.fn(),
    }),
  };
});

jest.mock('@/lib/logger', () => ({
  createScopedLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

// The mocks above are hoisted, so the component below loads with every boundary
// already swapped for its double.
import { NotificationItem } from '../NotificationItem';

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderRow(state: PostViewerState): Promise<{
  renderer: TestRenderer.ReactTestRenderer;
  queryClient: QueryClient;
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // Seed the post-detail query the row reads. With the row's 60s staleTime the
  // seeded (fresh) data is served synchronously and `getPostById` is never hit.
  queryClient.setQueryData(queryKeys.post(POST_ID), collabPost(state));

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <NotificationItem item={collabInviteItem()} onMarkAsRead={jest.fn()} onDelete={jest.fn()} />
      </QueryClientProvider>,
    );
  });
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
    expect(mockDecline).toHaveBeenCalledWith(POST_ID);
    expect(mockCachePosts).toHaveBeenCalledWith([collabPost(DECLINED)]);

    // The row is now resolved — no longer actionable.
    const rendered = texts(renderer.root);
    expect(rendered).toContain('You declined');
    expect(rendered).not.toContain('Decline');
  });
});
