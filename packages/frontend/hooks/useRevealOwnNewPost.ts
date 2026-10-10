import { useEffect, useSyncExternalStore } from 'react';
import {
    getLocalPostRevision,
    subscribeToLocalPostRevision,
} from '@/stores/feedScrollStore';

/**
 * After the viewer publishes, the feed their post lands in scrolls to the top so
 * the post is in view.
 *
 * The post is inserted at the head of the list (`postsStore.createPost`), but the
 * list keeps the reader where they were: FlashList holds the previously first row
 * still (its `maintainVisibleContentPosition`), and on web the route's saved
 * offset is restored on the way back from the composer. Either way the new post
 * ended up above the fold, cut off under the header (OxyHQ/Mention#1140).
 *
 * The feed is usually NOT in front when the post is created — the composer is —
 * so this is not a scroll at publish time. Each publish advances one shared
 * revision (`publishNewLocalPost`), and a feed that can hold the post answers it
 * the next time it is in front, once. Remembered per feed identity at module
 * scope, because on web the feed unmounts while the composer is open and a
 * remount must still know it has a publish to answer.
 */
const answeredRevisionByFeed = new Map<string, number>();

export function useRevealOwnNewPost({
    feedKey,
    enabled,
    scrollToTop,
}: {
    /** The feed's identity (`feedState.feedScrollKey`). */
    feedKey: string;
    /** In front, scroll-owning, done restoring, and a feed the post lands in. */
    enabled: boolean;
    scrollToTop: () => void;
}): void {
    const revision = useSyncExternalStore(
        subscribeToLocalPostRevision,
        getLocalPostRevision,
        getLocalPostRevision,
    );

    useEffect(() => {
        if (!enabled || revision === 0) return;
        if ((answeredRevisionByFeed.get(feedKey) ?? 0) >= revision) return;
        // A frame later: the inserted row has to be laid out before the top of
        // the list is the top of the post.
        const frame = requestAnimationFrame(() => {
            answeredRevisionByFeed.set(feedKey, revision);
            scrollToTop();
        });
        return () => cancelAnimationFrame(frame);
    }, [enabled, revision, feedKey, scrollToTop]);
}

/** For tests. */
export function resetRevealOwnNewPost(): void {
    answeredRevisionByFeed.clear();
}
