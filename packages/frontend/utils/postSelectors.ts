import { usePostsStore } from '@/stores/postsStore';
import { getPostById as dbGetPostById } from '@/db';
import { logger } from '@/lib/logger';

/**
 * Get post from store by ID — reads from SQLite cache
 */
export function getPostFromStore(postId: string | undefined): any {
    if (!postId) return null;
    
    try {
        // Direct SQLite lookup — O(1) indexed read
        return dbGetPostById(postId);
    } catch (error) {
        logger.error('Error getting post from store', { error });
    }
    
    return null;
}
