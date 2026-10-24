import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedPost } from '@mention/shared-types';

import { PostMenuContent } from '../PostMenuContent';

/**
 * The rows of a post's ⋯ menu: which are offered to whom. The menu is built
 * when the content mounts (the header mounts it on open), against the post as
 * the store holds it then.
 */

const mockPosts = new Map<string, HydratedPost>();
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: {
    getState: () => ({
      getPostFromDb: (id: string) => mockPosts.get(id) ?? null,
      removePostEverywhere: jest.fn(),
      reinsertPost: jest.fn(),
      updatePostEverywhere: jest.fn(),
    }),
  },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => false }),
}));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => ({}),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#888', error: '#f00' } }),
}));
let mockAuth: Record<string, unknown> = {};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (u: { username?: string } | null) => u?.username ?? null,
}));
jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/services/muteService', () => ({ muteService: {} }));
jest.mock('@/services/lanesService', () => ({ lanesService: {} }));
jest.mock('@/services/reportService', () => ({ reportService: {} }));
jest.mock('@/services/communityService', () => ({ communityService: {} }));
jest.mock('@/stores/laneInvalidation', () => ({ noteLaneListsChanged: jest.fn() }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@oxy.so/bloom/bottom-sheet', () => ({ BottomSheet: 'BottomSheet' }));
jest.mock('@/hooks/useCommunitiesPreview', () => ({ useCommunitiesPreview: () => true }));
let mockOperates = false;
const mockUseOperatesAccount = jest.fn((_params: unknown) => mockOperates);
jest.mock('@/components/Profile/hooks/useOperatesAccount', () => ({
  useOperatesAccount: (params: unknown) => mockUseOperatesAccount(params),
}));
const mockNoteSheets = {
  canWrite: false,
  canRate: false,
  openAbout: jest.fn(),
  openWriteFlow: jest.fn(),
};
jest.mock('@/components/CommunityNotes/useCommunityNoteSheets', () => ({
  createCommunityNoteSheets: () => mockNoteSheets,
}));

function post(id: string, viewerState: Partial<HydratedPost['viewerState']> = {}): HydratedPost {
  return {
    id,
    user: { id: `author-${id}`, username: 'author', name: { displayName: 'Author' } },
    authors: [],
    content: { text: 'hi' },
    attachments: {},
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
    viewerState: { isOwner: false, isSaved: false, ...viewerState },
    permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
  } as HydratedPost;
}

function rows(viewPost: HydratedPost) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PostMenuContent post={viewPost} isPostDetail={false} onOpenArticle={jest.fn()} />,
    );
  });
  return renderer.root
    .findAll((node) => node.type === Text && node.props.accessibilityRole === 'menuitem')
    .map((node) => ({ label: String(node.props.children), onPress: node.props.onPress }));
}

const labels = (viewPost: HydratedPost) => rows(viewPost).map((row) => row.label);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPosts.clear();
  mockOperates = false;
  mockNoteSheets.canWrite = false;
  mockAuth = { user: { id: 'viewer-1' }, isAuthenticated: true, canUsePrivateApi: true };
});

describe('PostMenuContent', () => {
  it.each([false, true])(
    'honors the server insight permission over ownership (allowed: %s)',
    (allowed) => {
      const item = post('insights-permission', { isOwner: !allowed });
      item.permissions = { ...item.permissions, canViewInsights: allowed };
      expect(labels(item).includes('postActions.insights')).toBe(allowed);
    },
  );

  it.each([false, true])('offers saving only with a ready session (ready: %s)', (ready) => {
    mockAuth = { user: ready ? { id: 'viewer-1' } : null, canUsePrivateApi: ready };
    expect(labels(post('menu-save')).includes('postActions.save')).toBe(ready);
  });

  it('is built from the canonical post in the store, not the copy the row rendered', () => {
    // The row rendered a stranger's post; the store says the viewer owns it.
    mockPosts.set('owned', post('owned', { isOwner: true }));
    const shown = labels(post('owned'));
    expect(shown).toContain('postActions.delete');
    expect(shown).not.toContain('postActions.reportPost');
  });

  it("offers a community's moderation only to its moderators", () => {
    const inCommunity = {
      ...post('in-forum'),
      community: { id: 'forum-1', username: 'forum', kind: 'community', isFederated: false },
    } as HydratedPost;

    mockOperates = true;
    expect(labels(inCommunity)).toContain('Remove from !{{community}}');
    expect(mockUseOperatesAccount).toHaveBeenCalledWith({
      accountId: 'forum-1',
      accountKind: 'community',
    });

    mockOperates = false;
    expect(labels(inCommunity)).not.toContain('Remove from !{{community}}');
  });

  it('offers "Add community note" to a non-owner only when a writer is configured', () => {
    mockNoteSheets.canWrite = true;
    const add = rows(post('n')).find((row) => row.label === 'Add community note');
    expect(add).toBeDefined();
    add?.onPress();
    expect(mockNoteSheets.openWriteFlow).toHaveBeenCalled();

    mockPosts.set('own', post('own', { isOwner: true }));
    expect(labels(post('own'))).not.toContain('Add community note');
  });
});
