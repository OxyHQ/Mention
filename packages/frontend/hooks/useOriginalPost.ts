import { useState, useEffect } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { getPostFromStore } from '@/utils/postSelectors';
import { useUsersStore } from '@/stores/usersStore';

interface UseOriginalPostParams {
    post: any;
    isNested: boolean;
    nestingDepth: number;
}

export function useOriginalPost({ post, isNested, nestingDepth }: UseOriginalPostParams) {
    const [originalPost, setOriginalPost] = useState<any>(() => {
        // Support both 'original' and 'quoted' keys
        return post?.original || post?.quoted || null;
    });

    const { getPostById } = usePostsStore();
    const postId = post?.id;

    useEffect(() => {
        // If backend embedded original/quoted data is present, use it
        if (post?.original || post?.quoted) {
            setOriginalPost(post.original || post.quoted);
            return;
        }

        // Don't load nested content if we're at max nesting depth
        if (isNested && nestingDepth >= 2) {
            setOriginalPost(null);
            return;
        }

        const targetId = post?.originalPostId || post?.repostOf || post?.quoteOf;
        if (!targetId || isNested) {
            setOriginalPost(null);
            return;
        }

        const loadOriginalPost = async () => {
            // Try store first for fully hydrated user data
            const fromStore = getPostFromStore(targetId);
            if (fromStore) {
                setOriginalPost(fromStore);
                return;
            }

            try {
                const original = await getPostById(targetId);
                setOriginalPost(original);
            } catch (error: any) {
                // Silently handle 404s - post may have been deleted
                if (error?.response?.status !== 404) {
                    console.error('Error loading original/quoted post:', error);
                }
            }
        };

        loadOriginalPost();
    }, [postId, post?.original, post?.quoted, post?.originalPostId, post?.repostOf, post?.quoteOf, isNested, nestingDepth, getPostById]);

    // Prime users cache from embedded user objects
    useEffect(() => {
        try {
            const state: any = useUsersStore.getState();
            const candidates: any[] = [];
            
            const postUser = post?.user;
            if (postUser) candidates.push(postUser);
            
            const originalUser = originalPost?.user;
            if (originalUser) candidates.push(originalUser);
            
            if (candidates.length) {
                if (typeof state?.upsertMany === 'function') {
                    state.upsertMany(candidates);
                } else if (typeof state?.upsertUser === 'function') {
                    candidates.forEach((usr) => state.upsertUser(usr));
                }
            }
        } catch (error) {
            // Silently fail
        }
    }, [post?.user, originalPost?.user]);

    return originalPost;
}

