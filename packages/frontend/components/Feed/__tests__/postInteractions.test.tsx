import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedPost } from '@mention/shared-types';

import {
    PostInteractionsProvider,
    usePostInteractions,
    type PostInteractions,
} from '../postInteractions';
import { PostInteractionsBinder } from '../PostInteractionsBinder';

/**
 * The feed row's one command controller (#1103). What it must keep from the
 * per-row hooks it replaced — optimistic writes through the store, attribution
 * on the positive action only, one write per tap — and what it must add: every
 * command acts on the post as the store holds it WHEN PRESSED, not on the copy
 * the row happened to render.
 */

const mockStore = {
    posts: new Map<string, HydratedPost>(),
    likePost: jest.fn(async () => undefined),
    unlikePost: jest.fn(async () => undefined),
    downvotePost: jest.fn(async () => undefined),
    savePost: jest.fn(async () => undefined),
    unsavePost: jest.fn(async () => undefined),
    boostPost: jest.fn(async () => undefined),
    unboostPost: jest.fn(async () => undefined),
    removePostEverywhere: jest.fn(),
    reinsertPost: jest.fn(),
    updatePostEverywhere: jest.fn(),
};

jest.mock('@/stores/postsStore', () => ({
    usePostsStore: {
        getState: () => ({
            ...mockStore,
            getPostFromDb: (id: string) => mockStore.posts.get(id) ?? null,
        }),
    },
}));

const mockShare = jest.fn();
jest.mock('@/hooks/usePostShare', () => ({ sharePost: (post: unknown) => mockShare(post) }));

const mockShowActionMenu = jest.fn();
jest.mock('@/components/common/ActionMenu', () => ({
    showActionMenu: (request: unknown) => mockShowActionMenu(request),
}));

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => false }),
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
    useTheme: () => ({ colors: { textSecondary: '#888', error: '#f00' } }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer-1' } }) }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/core', () => ({ getNormalizedUserHandle: (u: { username?: string } | null) => u?.username ?? null }));
jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/services/muteService', () => ({ muteService: {} }));
jest.mock('@/services/lanesService', () => ({ lanesService: {} }));
jest.mock('@/services/reportService', () => ({ reportService: {} }));
jest.mock('@/stores/laneInvalidation', () => ({ noteLaneListsChanged: jest.fn() }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@oxy.so/bloom/bottom-sheet', () => ({ BottomSheet: 'BottomSheet' }));
jest.mock('@/components/CommunityNotes/useCommunityNoteSheets', () => ({
    createCommunityNoteSheets: () => ({ canWrite: false, canRate: false, openAbout: jest.fn(), openWriteFlow: jest.fn() }),
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
        viewerState: {
            isOwner: false,
            isCollaborator: false,
            isLiked: false,
            isDownvoted: false,
            isBoosted: false,
            isSaved: false,
            ...viewerState,
        },
        permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
    } as HydratedPost;
}

function capture(tree: (probe: React.ReactElement) => React.ReactElement): PostInteractions {
    let interactions: PostInteractions | undefined;
    const Probe = () => {
        interactions = usePostInteractions();
        return null;
    };
    act(() => {
        TestRenderer.create(tree(<Probe />));
    });
    if (!interactions) throw new Error('probe did not render');
    return interactions;
}

beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockStore.posts.clear();
});

describe('engagement commands', () => {
    const interactions = () => capture((probe) => probe);

    it('likes with the feed as attribution, and unlikes without it', async () => {
        const commands = interactions();
        await commands.toggleLike(post('a'), 'for_you');
        expect(mockStore.likePost).toHaveBeenCalledWith({ postId: 'a', type: 'post' }, 'for_you');

        mockStore.posts.set('b', post('b', { isLiked: true }));
        await commands.toggleLike(post('b'), 'for_you');
        expect(mockStore.unlikePost).toHaveBeenCalledWith({ postId: 'b', type: 'post' });
    });

    it('acts on the store copy at press time, not the copy the row rendered', async () => {
        // The row rendered "not saved"; the store has since learned it IS saved
        // (another surface, a server echo). A captured flag would save it twice.
        mockStore.posts.set('p', post('p', { isSaved: true }));
        await interactions().toggleSave(post('p'), 'following');
        expect(mockStore.unsavePost).toHaveBeenCalledWith({ postId: 'p' });
        expect(mockStore.savePost).not.toHaveBeenCalled();
    });

    it('falls back to the row copy when the store has never seen the post', async () => {
        await interactions().toggleBoost(post('web-only', { isBoosted: true }));
        expect(mockStore.unboostPost).toHaveBeenCalledWith({ postId: 'web-only' });
    });

    it('ignores a second tap while the first write is in flight', async () => {
        let release!: () => void;
        mockStore.likePost.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
        }));
        const commands = interactions();
        const first = commands.toggleLike(post('x'));
        await commands.toggleLike(post('x'));
        expect(mockStore.likePost).toHaveBeenCalledTimes(1);
        expect(mockStore.unlikePost).not.toHaveBeenCalled();
        release();
        await first;
        // …and the guard releases: the next tap goes through.
        await commands.toggleLike(post('x'));
        expect(mockStore.likePost).toHaveBeenCalledTimes(2);
    });

    it('downvotes, and a second downvote retracts through unlike', async () => {
        const commands = interactions();
        await commands.toggleDownvote(post('d'));
        expect(mockStore.downvotePost).toHaveBeenCalledWith({ postId: 'd', type: 'post' });
        mockStore.posts.set('d', post('d', { isDownvoted: true }));
        await commands.toggleDownvote(post('d'));
        expect(mockStore.unlikePost).toHaveBeenCalledWith({ postId: 'd', type: 'post' });
    });

    it('shares the canonical copy', () => {
        const canonical = post('s');
        mockStore.posts.set('s', canonical);
        interactions().share(post('s'));
        expect(mockShare).toHaveBeenCalledWith(canonical);
    });
});

describe('menu', () => {
    it('without a binder, opening the menu is a logged no-op', () => {
        const commands = capture((probe) => <PostInteractionsProvider>{probe}</PostInteractionsProvider>);
        expect(() => commands.openMenu({ post: post('m'), isPostDetail: false, onOpenArticle: jest.fn() })).not.toThrow();
        expect(mockShowActionMenu).not.toHaveBeenCalled();
    });

    it('is built at press time from the canonical post', () => {
        const commands = capture((probe) => (
            <PostInteractionsProvider>
                <PostInteractionsBinder />
                {probe}
            </PostInteractionsProvider>
        ));

        // The row rendered a stranger's post; the store says the viewer owns it
        // (an ownership the row never saw). The menu must offer Delete.
        mockStore.posts.set('owned', post('owned', { isOwner: true }));
        commands.openMenu({ post: post('owned'), isPostDetail: false, onOpenArticle: jest.fn() });

        expect(mockShowActionMenu).toHaveBeenCalledTimes(1);
        const labels = (mockShowActionMenu.mock.calls[0][0] as { groups: { label: string }[][] }).groups
            .flat()
            .map((action) => action.label);
        expect(labels).toContain('postActions.delete');
        expect(labels).not.toContain('postActions.reportPost');
    });

    it('builds nothing until pressed', () => {
        capture((probe) => (
            <PostInteractionsProvider>
                <PostInteractionsBinder />
                {probe}
            </PostInteractionsProvider>
        ));
        expect(mockShowActionMenu).not.toHaveBeenCalled();
    });
});
