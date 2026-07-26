import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * @param source Optional originating feed descriptor for surface-aware
 *   engagement attribution; attached to the SAVE write, ignored on unsave.
 */
export function usePostSave(postId: string | undefined, isSaved: boolean, source?: string) {
    const { savePost, unsavePost } = usePostsStore();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const pendingRef = useRef(false);
    const viewerId = user?.id;

    const toggleSave = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isSaved
                ? unsavePost({ postId })
                : savePost({ postId }, source);

            await action;

            // The saved screen is page-owned by React Query, while engagement
            // state lives in postsStore. Revalidate every saved filter/folder
            // after the command succeeds so an unsaved row disappears and a
            // newly-saved post becomes eligible without remounting the screen.
            if (viewerId) {
                void queryClient.invalidateQueries({
                    queryKey: viewerQueryKeys.savedPostsRoot(viewerId),
                });
            }
        } catch (error) {
            logger.error('Error toggling save', { error });
        } finally {
            pendingRef.current = false;
        }
    }, [
        postId,
        isSaved,
        savePost,
        unsavePost,
        source,
        viewerId,
        queryClient,
    ]);

    return toggleSave;
}
