import React, { createContext, useContext, useState, type ReactNode } from 'react';
import { createLogger } from '@oxy.so/core/logger';
import type { CommunityNoteSummary, HydratedPost, PostSourceLink } from '@mention/shared-types';
import { sharePost } from '@/hooks/usePostShare';
import { usePostsStore } from '@/stores/postsStore';

const logger = createLogger('postInteractions');

/**
 * What a feed row can DO, as one app-lifetime controller (issue #1103).
 *
 * A row used to instantiate a controller for every action it might ever offer:
 * four engagement hooks (nine store subscriptions between them), the overflow
 * menu (theme, auth, i18n, router, safe-back, bottom sheet, query client, three
 * more selectors and nine action arrays of JSX), the community-note flows and
 * the share handler — per mounted row, every fling, though a reader opens the
 * menu of almost none of them. Now the row reads ONE stable context value and
 * calls a command; the command does the work at press time.
 *
 * Every command resolves the post as the store holds it WHEN PRESSED, falling
 * back to the copy the row rendered (web's memory-mode feed holds rows the store
 * never saw). A captured copy can no longer make a menu act on stale state.
 *
 * Engagement writes keep their exact semantics: the store's optimistic update
 * and rollback, its engagement-list invalidation, and the feed descriptor as
 * the attribution `source` on like / save / boost (never on the undo). A
 * re-entrancy guard per post and action ignores a second tap while the first is
 * in flight, as the per-row hooks did.
 */
export interface PostInteractions {
    toggleLike: (post: HydratedPost, source?: string) => Promise<void>;
    toggleDownvote: (post: HydratedPost) => Promise<void>;
    toggleSave: (post: HydratedPost, source?: string) => Promise<void>;
    toggleBoost: (post: HydratedPost, source?: string) => Promise<void>;
    share: (post: HydratedPost) => void;
    openMenu: (request: PostMenuRequest) => void;
    openSources: (sources: PostSourceLink[]) => void;
    openInsights: (postId: string) => void;
    openCommunityNoteAbout: (note: CommunityNoteSummary) => void;
}

export interface PostMenuRequest {
    post: HydratedPost;
    /** The focused post on `/p/<id>`: deleting it also leaves the screen. */
    isPostDetail: boolean;
    /** Feed descriptor, attributed to a save made from the menu. */
    source?: string;
    /** The article reader is row-local state (a modal the row renders). */
    onOpenArticle: () => void;
}

/**
 * The commands that need app services (the bottom sheet, the router, i18n, the
 * viewer…). `PostInteractionsBinder` implements and binds them; keeping them
 * out of this module keeps the session SDK and the menu's service graph out of
 * every module that renders a row.
 */
export type BoundPostCommands = Pick<
    PostInteractions,
    'openMenu' | 'openSources' | 'openInsights' | 'openCommunityNoteAbout'
>;

/** The canonical copy of a post right now, or the row's copy when the store has none. */
export function currentPost(post: HydratedPost): HydratedPost {
    return (usePostsStore.getState().getPostFromDb(post.id) as HydratedPost | null) ?? post;
}

const inFlight = new Set<string>();

async function guarded(key: string, action: () => Promise<unknown>, what: string): Promise<void> {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
        await action();
    } catch (error) {
        logger.error(`Error toggling ${what}`, error);
    } finally {
        inFlight.delete(key);
    }
}

/** Save/unsave the post as it stands now; the menu's Save entry uses it too. */
export function toggleSave(post: HydratedPost, source?: string): Promise<void> {
    const store = usePostsStore.getState();
    const isSaved = currentPost(post).viewerState?.isSaved ?? false;
    return guarded(
        `${post.id}:save`,
        () => (isSaved ? store.unsavePost({ postId: post.id }) : store.savePost({ postId: post.id }, source)),
        'save',
    );
}

interface Controller {
    interactions: PostInteractions;
    bind: (commands: BoundPostCommands | null) => void;
}

function createController(): Controller {
    let bound: BoundPostCommands | null = null;
    const whenBound = <K extends keyof BoundPostCommands>(name: K) =>
        ((...args: Parameters<BoundPostCommands[K]>) => {
            if (!bound) {
                logger.warn(`${name}: no PostInteractionsBinder is mounted`);
                return;
            }
            (bound[name] as (...a: Parameters<BoundPostCommands[K]>) => void)(...args);
        }) as BoundPostCommands[K];

    const interactions: PostInteractions = {
        toggleLike: (post, source) => {
            const store = usePostsStore.getState();
            const isLiked = currentPost(post).viewerState?.isLiked ?? false;
            return guarded(
                `${post.id}:like`,
                () =>
                    isLiked
                        ? store.unlikePost({ postId: post.id, type: 'post' })
                        : store.likePost({ postId: post.id, type: 'post' }, source),
                'like',
            );
        },
        toggleDownvote: (post) => {
            const store = usePostsStore.getState();
            const isDownvoted = currentPost(post).viewerState?.isDownvoted ?? false;
            return guarded(
                `${post.id}:downvote`,
                () =>
                    isDownvoted
                        ? store.unlikePost({ postId: post.id, type: 'post' })
                        : store.downvotePost({ postId: post.id, type: 'post' }),
                'downvote',
            );
        },
        toggleSave,
        toggleBoost: (post, source) => {
            const store = usePostsStore.getState();
            const isBoosted = currentPost(post).viewerState?.isBoosted ?? false;
            return guarded(
                `${post.id}:boost`,
                () => (isBoosted ? store.unboostPost({ postId: post.id }) : store.boostPost({ postId: post.id }, source)),
                'boost',
            );
        },
        share: (post) => {
            void sharePost(currentPost(post));
        },
        openMenu: whenBound('openMenu'),
        openSources: whenBound('openSources'),
        openInsights: whenBound('openInsights'),
        openCommunityNoteAbout: whenBound('openCommunityNoteAbout'),
    };

    return {
        interactions,
        bind: (commands) => {
            bound = commands;
        },
    };
}

/**
 * Outside any provider (a test rendering one row, a preview) the engagement
 * commands still work — they need only the store — and the sheet/menu commands
 * log and do nothing.
 */
const fallbackController = createController();

const PostInteractionsContext = createContext<Controller>(fallbackController);

/** One stable object for the app's lifetime: reading it never re-renders a row. */
export function usePostInteractions(): PostInteractions {
    return useContext(PostInteractionsContext).interactions;
}

/** For `PostInteractionsBinder` only. */
export function usePostInteractionsBinding(): Controller['bind'] {
    return useContext(PostInteractionsContext).bind;
}

/**
 * Mounted ABOVE the bottom sheet provider, because the sheet renders its content
 * at its own depth — a post shown inside a sheet must still find the controller.
 * The service-backed commands are bound from below by `PostInteractionsBinder`.
 */
export function PostInteractionsProvider({ children }: { children: ReactNode }) {
    const [controller] = useState(createController);
    return <PostInteractionsContext.Provider value={controller}>{children}</PostInteractionsContext.Provider>;
}
