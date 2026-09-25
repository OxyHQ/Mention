import { PostVisibility } from '@mention/shared-types';
import type { HydratedPost } from '@mention/shared-types';

import { buildPostMenuActions, type PostMenuDeps, type PostMenuParams } from '../postMenuActions';

/**
 * Which actions the ⋯ menu offers, and for whom. The menu is built on press
 * (#1103) from the canonical post, so these are the branches that decide what a
 * reader may do to a post: owner-only settings, the personal 30-minute edit
 * window against a channel's permanent one, lanes only on original posts, and
 * the optimistic delete with its rollback.
 */

const mockStore = {
    removePostEverywhere: jest.fn(),
    reinsertPost: jest.fn(),
    updatePostEverywhere: jest.fn(),
    getPostFromDb: jest.fn(() => null),
};
jest.mock('@/stores/postsStore', () => ({ usePostsStore: { getState: () => mockStore } }));

const mockFeedService = {
    deletePost: jest.fn(async () => undefined),
    updatePostSettings: jest.fn(async () => undefined),
    stopCollabSharing: jest.fn(async () => ({ post: null })),
};
jest.mock('@/services/feedService', () => ({
    get feedService() {
        return mockFeedService;
    },
}));

const mockConfirm = jest.fn(async () => true);
jest.mock('@/utils/alerts', () => ({ confirmDialog: () => mockConfirm() }));

const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

const mockMute = { muteUser: jest.fn(async () => true) };
jest.mock('@/services/muteService', () => ({
    get muteService() {
        return mockMute;
    },
}));
const mockLanes = { mute: jest.fn(async () => undefined), setPostLane: jest.fn(async () => null) };
jest.mock('@/services/lanesService', () => ({
    get lanesService() {
        return mockLanes;
    },
}));
const mockReport = { reportPost: jest.fn(async () => true) };
jest.mock('@/services/reportService', () => ({
    get reportService() {
        return mockReport;
    },
}));
jest.mock('@/stores/laneInvalidation', () => ({ noteLaneListsChanged: jest.fn() }));
const mockInvalidateCounts = jest.fn();
jest.mock('@/stores/profileCountsInvalidation', () => ({
    invalidateProfileCounts: (...args: unknown[]) => mockInvalidateCounts(...args),
}));

const mockClipboard = { setStringAsync: jest.fn(async (_text: string) => true) };
jest.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => mockClipboard.setStringAsync(text),
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@oxy.so/core', () => ({
    getNormalizedUserHandle: (user: { username?: string } | null) => user?.username ?? null,
}));

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

function makePost(overrides: Partial<HydratedPost> = {}, createdAt = '2026-09-25T11:50:00.000Z'): HydratedPost {
    return {
        id: 'p1',
        user: { id: 'author-1', username: 'ana', name: { displayName: 'Ana' } },
        authors: [],
        content: { text: 'hi' },
        attachments: {},
        metadata: { visibility: PostVisibility.PUBLIC, createdAt, updatedAt: createdAt },
        engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
        viewerState: {
            isOwner: false,
            isCollaborator: false,
            isLiked: false,
            isDownvoted: false,
            isBoosted: false,
            isSaved: false,
        },
        permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
        ...overrides,
    } as HydratedPost;
}

const bottomSheet = { setBottomSheetContent: jest.fn(), openBottomSheet: jest.fn() };
const router = { push: jest.fn() };
const queryClient = { invalidateQueries: jest.fn() };
const safeBack = jest.fn();

const deps = {
    theme: { colors: { textSecondary: '#888', error: '#f00' } },
    t: (key: string) => key,
    viewerId: 'viewer-1',
    canUsePrivateApi: true,
    router,
    safeBack,
    bottomSheet,
    queryClient,
} as unknown as PostMenuDeps;

function build(
    params: Partial<PostMenuParams> & { viewPost: HydratedPost },
    depOverrides: Partial<PostMenuDeps> = {},
) {
    return buildPostMenuActions(
        {
            isOwner: false,
            isPostDetail: false,
            canViewInsights: false,
            canStopSharing: false,
            isSaved: false,
            hasArticle: false,
            hasSources: false,
            onSave: jest.fn(async () => undefined),
            onOpenArticle: jest.fn(),
            onOpenSources: jest.fn(),
            ...params,
        },
        { ...deps, ...depOverrides },
    );
}

const labels = (actions: ReturnType<typeof build>) =>
    Object.values(actions)
        .flat()
        .map((action) => action.label);

beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
});
afterAll(() => {
    jest.useRealTimers();
});
beforeEach(() => jest.clearAllMocks());

describe('who gets which actions', () => {
    it("offers a stranger's post save, lists, mute, report and copy link — no owner settings", () => {
        const actions = build({ viewPost: makePost() });
        expect(labels(actions)).toEqual(
            expect.arrayContaining([
                'postActions.save',
                'lists.addTo.menuItem',
                'postActions.muteUser',
                'postActions.reportPost',
                'postActions.copyLink',
            ]),
        );
        expect(labels(actions)).not.toContain('postActions.delete');
        expect(labels(actions)).not.toContain('postActions.edit');
        expect(labels(actions)).not.toContain('postActions.pinToProfile');
        expect(actions.insightsAction).toEqual([]);
    });

    // #1126: every one of these is a write on the viewer's account, so signed
    // out it could only answer 401. Reading actions stay.
    it('offers a signed-out reader only what needs no session', () => {
        const signedOut = { viewerId: undefined, canUsePrivateApi: false };
        const onLane = makePost({ lane: { id: 'l1', name: 'Dev notes' } as HydratedPost['lane'] });
        const actions = build({ viewPost: onLane, hasArticle: true, hasSources: true }, signedOut);

        expect(labels(actions).sort()).toEqual(
            ['post.viewArticle', 'post.viewSources', 'postActions.copyLink'].sort(),
        );
        expect(actions.saveActionGroup).toEqual([]);
        expect(actions.addToListAction).toEqual([]);
        expect(actions.muteReportAction).toEqual([]);
        // A saved flag left over from a signed-in render must not bring Unsave back.
        expect(labels(build({ viewPost: onLane, isSaved: true }, signedOut))).not.toContain('postActions.unsave');
    });

    it('offers a lane mute first when the post sits on a lane', () => {
        const actions = build({ viewPost: makePost({ lane: { id: 'l1', name: 'Dev notes' } as HydratedPost['lane'] }) });
        expect(actions.muteReportAction.map((a) => a.label)).toEqual([
            'lanes.postActions.muteLane',
            'postActions.muteUser',
            'postActions.reportPost',
        ]);
    });

    it('offers the owner edit inside the 30-minute window, and not after it', () => {
        const fresh = build({ viewPost: makePost(), isOwner: true });
        expect(labels(fresh)).toEqual(
            expect.arrayContaining(['postActions.edit', 'postActions.pinToProfile', 'postActions.delete']),
        );
        const old = build({ viewPost: makePost({}, '2026-09-25T10:00:00.000Z'), isOwner: true });
        expect(labels(old)).not.toContain('postActions.edit');
        expect(labels(old)).toContain('postActions.delete');
    });

    it('keeps a channel post editable for its whole life', () => {
        const channelPost = makePost(
            { user: { id: 'chan', username: 'news', kind: 'channel', name: { displayName: 'News' } } as HydratedPost['user'] },
            '2025-01-01T00:00:00.000Z',
        );
        expect(labels(build({ viewPost: channelPost, isOwner: true }))).toContain('postActions.edit');
    });

    it('offers moving between lanes only on an original post, never a reply or a boost', () => {
        expect(labels(build({ viewPost: makePost(), isOwner: true }))).toContain('lanes.postActions.moveToLane');
        const reply = makePost({ parentPostId: 'parent' });
        expect(labels(build({ viewPost: reply, isOwner: true }))).not.toContain('lanes.postActions.moveToLane');
    });

    it('labels pin and engagement-count toggles by their current state', () => {
        const pinnedHidden = makePost({
            metadata: {
                visibility: PostVisibility.PUBLIC,
                createdAt: '2026-09-25T11:50:00.000Z',
                updatedAt: '2026-09-25T11:50:00.000Z',
                isPinned: true,
                hideEngagementCounts: true,
            },
        } as Partial<HydratedPost>);
        const found = labels(build({ viewPost: pinnedHidden, isOwner: true }));
        expect(found).toEqual(expect.arrayContaining(['postActions.unpinFromProfile', 'postActions.showEngagementCounts']));
    });

    it('offers unsave on a saved post, insights and stop-sharing only when permitted, and article/sources when present', () => {
        const actions = build({
            viewPost: makePost(),
            isSaved: true,
            canViewInsights: true,
            canStopSharing: true,
            hasArticle: true,
            hasSources: true,
        });
        expect(labels(actions)).toEqual(
            expect.arrayContaining([
                'postActions.unsave',
                'postActions.insights',
                'collab.stopSharing',
                'post.viewArticle',
                'post.viewSources',
            ]),
        );
    });
});

describe('what the actions do', () => {
    const find = (actions: ReturnType<typeof build>, label: string) => {
        const action = Object.values(actions).flat().find((a) => a.label === label);
        if (!action) throw new Error(`no action ${label}`);
        return action;
    };

    it('deletes optimistically and leaves the detail screen', async () => {
        const post = makePost();
        await find(build({ viewPost: post, isOwner: true, isPostDetail: true }), 'postActions.delete').onPress();
        expect(mockStore.removePostEverywhere).toHaveBeenCalledWith('p1');
        expect(safeBack).toHaveBeenCalled();
        expect(mockFeedService.deletePost).toHaveBeenCalledWith('p1');
        expect(queryClient.invalidateQueries).toHaveBeenCalled();
        // The author's profile counters drop by one (#1140).
        expect(mockInvalidateCounts).toHaveBeenCalledWith('author-1');
        expect(mockStore.reinsertPost).not.toHaveBeenCalled();
    });

    it('rolls a failed delete back and says so', async () => {
        mockFeedService.deletePost.mockRejectedValueOnce(new Error('500'));
        const post = makePost();
        await find(build({ viewPost: post, isOwner: true }), 'postActions.delete').onPress();
        expect(mockStore.reinsertPost).toHaveBeenCalledWith(post);
        expect(mockInvalidateCounts).not.toHaveBeenCalled();
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToDeletePost', { type: 'error' });
        expect(safeBack).not.toHaveBeenCalled();
    });

    it('does nothing when the delete is not confirmed', async () => {
        mockConfirm.mockResolvedValueOnce(false);
        await find(build({ viewPost: makePost(), isOwner: true }), 'postActions.delete').onPress();
        expect(mockStore.removePostEverywhere).not.toHaveBeenCalled();
    });

    it('pins through the settings endpoint and the store', async () => {
        await find(build({ viewPost: makePost(), isOwner: true }), 'postActions.pinToProfile').onPress();
        expect(mockFeedService.updatePostSettings).toHaveBeenCalledWith('p1', { isPinned: true });
        expect(mockStore.updatePostEverywhere).toHaveBeenCalled();
    });

    it('toasts when a pin fails', async () => {
        mockFeedService.updatePostSettings.mockRejectedValueOnce(new Error('nope'));
        await find(build({ viewPost: makePost(), isOwner: true }), 'postActions.pinToProfile').onPress();
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToPinPost', { type: 'error' });
    });

    it('hides engagement counts through the settings endpoint', async () => {
        await find(build({ viewPost: makePost(), isOwner: true }), 'postActions.hideEngagementCounts').onPress();
        expect(mockFeedService.updatePostSettings).toHaveBeenCalledWith('p1', { hideEngagementCounts: true });
    });

    it('opens its sheets in the one bottom sheet', () => {
        const actions = build({ viewPost: makePost({ lane: { id: 'l1', name: 'Dev' } as HydratedPost['lane'] }), isOwner: true, canViewInsights: true });
        for (const label of ['postActions.insights', 'lanes.postActions.moveToLane', 'postActions.replyOptions']) {
            bottomSheet.setBottomSheetContent.mockClear();
            find(actions, label).onPress();
            expect(bottomSheet.setBottomSheetContent).toHaveBeenCalledTimes(1);
            expect(bottomSheet.openBottomSheet).toHaveBeenLastCalledWith(true);
        }
        const strangerActions = build({ viewPost: makePost() });
        for (const label of ['postActions.reportPost', 'lists.addTo.menuItem']) {
            bottomSheet.setBottomSheetContent.mockClear();
            find(strangerActions, label).onPress();
            expect(bottomSheet.setBottomSheetContent).toHaveBeenCalledTimes(1);
        }
    });

    it('routes edit to the composer', () => {
        find(build({ viewPost: makePost(), isOwner: true }), 'postActions.edit').onPress();
        expect(router.push).toHaveBeenCalledWith('/compose?editPostId=p1');
    });

    it('mutes the author after confirmation', async () => {
        await find(build({ viewPost: makePost() }), 'postActions.muteUser').onPress();
        expect(mockMute.muteUser).toHaveBeenCalledWith('author-1');
        expect(mockToast).toHaveBeenCalledWith('postActions.userMuted', { type: 'success' });
    });

    it('mutes a lane after confirmation', async () => {
        const actions = build({ viewPost: makePost({ lane: { id: 'l1', name: 'Dev' } as HydratedPost['lane'] }) });
        await find(actions, 'lanes.postActions.muteLane').onPress();
        expect(mockLanes.mute).toHaveBeenCalledWith('l1');
    });

    it('stops sharing a collaboration and drops the post when the server returns none', async () => {
        await find(build({ viewPost: makePost(), canStopSharing: true }), 'collab.stopSharing').onPress();
        expect(mockFeedService.stopCollabSharing).toHaveBeenCalledWith('p1');
        expect(mockStore.removePostEverywhere).toHaveBeenCalledWith('p1');
    });

    it('copies the canonical post link', async () => {
        await find(build({ viewPost: makePost() }), 'postActions.copyLink').onPress();
        expect(mockClipboard.setStringAsync).toHaveBeenCalledWith('https://mention.earth/p/p1');
    });

    it('hands save, article and sources to the caller', () => {
        const onSave = jest.fn(async () => undefined);
        const onOpenArticle = jest.fn();
        const onOpenSources = jest.fn();
        const actions = build({ viewPost: makePost(), hasArticle: true, hasSources: true, onSave, onOpenArticle, onOpenSources });
        find(actions, 'postActions.save').onPress();
        find(actions, 'post.viewArticle').onPress();
        find(actions, 'post.viewSources').onPress();
        expect(onSave).toHaveBeenCalled();
        expect(onOpenArticle).toHaveBeenCalled();
        expect(onOpenSources).toHaveBeenCalled();
    });

    /** The element a sheet action handed the bottom sheet, unwrapped from its Suspense. */
    function sheetProps<P>(label: string, actions: ReturnType<typeof build>): P {
        bottomSheet.setBottomSheetContent.mockClear();
        find(actions, label).onPress();
        const suspense = bottomSheet.setBottomSheetContent.mock.calls[0][0] as { props: { children: { props: P } } };
        return suspense.props.children.props;
    }

    it("moves the post to the lane picked in the sheet, and toasts a failure", async () => {
        const actions = build({ viewPost: makePost(), isOwner: true });
        const picker = sheetProps<{ onSelect: (laneId: string | null) => Promise<void>; onClose: () => void }>(
            'lanes.postActions.moveToLane',
            actions,
        );
        await picker.onSelect('l2');
        expect(mockLanes.setPostLane).toHaveBeenCalledWith('p1', 'l2');
        expect(mockStore.updatePostEverywhere).toHaveBeenCalled();
        mockLanes.setPostLane.mockRejectedValueOnce(new Error('no'));
        await picker.onSelect('l3');
        expect(mockToast).toHaveBeenCalledWith('lanes.postActions.moveFailed', { type: 'error' });
        picker.onClose();
        expect(bottomSheet.openBottomSheet).toHaveBeenLastCalledWith(false);
    });

    it('writes reply and quote settings chosen in the sheet', async () => {
        const settings = sheetProps<{
            onReplyPermissionChange: (p: string[]) => Promise<void>;
            onQuotesDisabledChange: (d: boolean) => Promise<void>;
        }>('postActions.replyOptions', build({ viewPost: makePost(), isOwner: true }));
        await settings.onReplyPermissionChange(['followers']);
        expect(mockFeedService.updatePostSettings).toHaveBeenCalledWith('p1', { replyPermission: ['followers'] });
        await settings.onQuotesDisabledChange(true);
        expect(mockFeedService.updatePostSettings).toHaveBeenCalledWith('p1', { quotesDisabled: true });
        mockFeedService.updatePostSettings.mockRejectedValueOnce(new Error('x'));
        await settings.onReplyPermissionChange(['anyone']);
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToUpdateReplyPermissions', { type: 'error' });
        mockFeedService.updatePostSettings.mockRejectedValueOnce(new Error('x'));
        await settings.onQuotesDisabledChange(false);
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToUpdateQuoteSettings', { type: 'error' });
    });

    it('submits a report and thanks the reader, or says it failed', async () => {
        const modal = sheetProps<{ onSubmit: (c: string[], d: string) => Promise<void> }>(
            'postActions.reportPost',
            build({ viewPost: makePost() }),
        );
        await modal.onSubmit(['spam'], 'details');
        expect(mockReport.reportPost).toHaveBeenCalledWith('p1', ['spam'], 'details');
        expect(mockToast).toHaveBeenCalledWith('postActions.thankYouReport', { type: 'success' });
        mockReport.reportPost.mockResolvedValueOnce(false);
        await modal.onSubmit(['spam'], '');
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToSubmitReport', { type: 'error' });
    });

    it('keeps a collaboration the server still returns, and toasts a failed stop', async () => {
        const kept = makePost({ id: 'p1' });
        mockFeedService.stopCollabSharing.mockResolvedValueOnce({ post: kept } as never);
        await find(build({ viewPost: makePost(), canStopSharing: true }), 'collab.stopSharing').onPress();
        expect(mockStore.updatePostEverywhere).toHaveBeenCalled();
        expect(mockStore.removePostEverywhere).not.toHaveBeenCalled();
        mockFeedService.stopCollabSharing.mockRejectedValueOnce(new Error('x'));
        await find(build({ viewPost: makePost(), canStopSharing: true }), 'collab.stopSharing').onPress();
        expect(mockToast).toHaveBeenCalledWith('collab.stopSharingFailed', { type: 'error' });
    });

    it('says so when muting the author fails', async () => {
        mockMute.muteUser.mockResolvedValueOnce(false);
        await find(build({ viewPost: makePost() }), 'postActions.muteUser').onPress();
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToMuteUser', { type: 'error' });
    });

    it('toasts a failed engagement-count toggle and a failed lane mute', async () => {
        mockFeedService.updatePostSettings.mockRejectedValueOnce(new Error('x'));
        await find(build({ viewPost: makePost(), isOwner: true }), 'postActions.hideEngagementCounts').onPress();
        expect(mockToast).toHaveBeenCalledWith('postActions.failedToUpdateEngagement', { type: 'error' });
        mockLanes.mute.mockRejectedValueOnce(new Error('x'));
        const laneActions = build({ viewPost: makePost({ lane: { id: 'l1', name: 'Dev' } as HydratedPost['lane'] }) });
        await find(laneActions, 'lanes.postActions.muteLane').onPress();
        expect(mockToast).toHaveBeenCalledWith('lanes.postActions.muteLaneFailed', { type: 'error' });
    });
});
