import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

/**
 * Get post from store by ID - checks entity cache first, then falls back to feeds
 */
export function getPostFromStore(postId: string | undefined): any {
    if (!postId) return null;
    
    try {
        const { postsById, feeds } = usePostsStore.getState();
        
        // Fast path: check entity cache first
        if (postsById[postId]) {
            return postsById[postId];
        }
        
        // Fallback: scan feeds (should rarely happen)
        const types = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;
        for (const feedType of types) {
            const match = (feeds as any)[feedType]?.items?.find((p: any) => p.id === postId);
            if (match) return match;
        }
    } catch (error) {
        logger.error('Error getting post from store', { error });
    }
    
    return null;
}

