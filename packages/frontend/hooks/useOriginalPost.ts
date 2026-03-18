import { useState, useEffect, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';
import { getPostFromStore } from '@/utils/postSelectors';
import { useUsersStore } from '@/stores/usersStore';

interface UseOriginalPostParams {
    post: any;
    isNested: boolean;
    nestingDepth: number;
}

/**
 * Prime the users cache from embedded user objects on a post.
 * Called imperatively when data arrives rather than in a reactive effect.
 */
function primeUsersCache(postUser: any, originalUser: any): void {
    try {
        const state: any = useUsersStore.getState();
        const candidates: any[] = [];

        if (postUser) candidates.push(postUser);
        if (originalUser) candidates.push(originalUser);

        if (candidates.length) {
            if (typeof state?.upsertMany === 'function') {
                state.upsertMany(candidates);
            } else if (typeof state?.upsertUser === 'function') {
                candidates.forEach((usr) => state.upsertUser(usr));
            }
        }
    } catch {
        // Silently fail
    }
}

export function useOriginalPost({ post, isNested, nestingDepth }: UseOriginalPostParams) {
    // Synchronously derive embedded post from props — no effect needed
    const embeddedPost = post?.original || post?.quoted || null;

    // State only tracks async-fetched posts (when no embedded data is available)
    const [fetchedPost, setFetchedPost] = useState<any>(null);
    const prevPostIdRef = useRef<string | undefined>(undefined);

    const { getPostById } = usePostsStore();
    const postId = post?.id;

    // Reset fetched post when the source post changes
    if (prevPostIdRef.current !== postId) {
        prevPostIdRef.current = postId;
        if (fetchedPost !== null) {
            setFetchedPost(null);
        }
    }

    // Async fetch for posts without embedded data
    useEffect(() => {
        // If embedded data is present, no fetch needed
        if (embeddedPost) {
            primeUsersCache(post?.user, embeddedPost?.user);
            return;
        }

        // Don't load nested content if we're at max nesting depth
        if (isNested && nestingDepth >= 2) {
            return;
        }

        const targetId = post?.originalPostId || post?.repostOf || post?.quoteOf;
        if (!targetId || isNested) {
            return;
        }

        let cancelled = false;

        const loadOriginalPost = async () => {
            // Try store first for fully hydrated user data
            const fromStore = getPostFromStore(targetId);
            if (fromStore) {
                if (!cancelled) {
                    setFetchedPost(fromStore);
                    primeUsersCache(post?.user, fromStore?.user);
                }
                return;
            }

            try {
                const original = await getPostById(targetId);
                if (!cancelled) {
                    setFetchedPost(original);
                    primeUsersCache(post?.user, original?.user);
                }
            } catch (error: any) {
                // Silently handle 404s - post may have been deleted
                if (error?.response?.status !== 404) {
                    logger.error('Error loading original/quoted post');
                }
            }
        };

        loadOriginalPost();

        return () => {
            cancelled = true;
        };
    }, [postId, embeddedPost, post?.originalPostId, post?.repostOf, post?.quoteOf, isNested, nestingDepth, getPostById, post?.user]);

    // Prefer embedded data from props; fall back to async-fetched data
    return embeddedPost ?? fetchedPost;
}
