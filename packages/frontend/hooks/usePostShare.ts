import { useCallback } from 'react';
import { Share, Platform, Alert } from 'react-native';
import { useUsersStore } from '@/stores/usersStore';

export function usePostShare(post: any) {
    const sharePost = useCallback(async () => {
        if (!post) return;

        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const content = typeof post.content === 'string' ? { text: post.content } : (post.content || {});
            const contentText = content.text || '';
            const user = post.user || {};
            const id = String(user.id || user._id || '');
            const name = (user?.name?.full) || 
                (user?.name?.first ? `${user.name.first} ${user.name.last || ''}`.trim() : '') || 
                user?.name || 
                user?.username || 
                user?.handle || 
                id || 
                'Someone';
            
            let handle = user?.handle || user?.username || '';
            if (!handle && id) {
                try { 
                    handle = useUsersStore.getState().usersById[id]?.data?.username || ''; 
                } catch { }
            }
            
            const shareMessage = contentText
                ? `${name}${handle ? ` (@${handle})` : ''}: ${contentText}`
                : `${name}${handle ? ` (@${handle})` : ''} shared a post`;

            if (Platform.OS === 'web') {
                if (navigator.share) {
                    await navigator.share({
                        title: `${name} on Mention`,
                        text: shareMessage,
                        url: postUrl
                    });
                } else {
                    await navigator.clipboard.writeText(`${shareMessage}\n\n${postUrl}`);
                    const { alertDialog } = await import('@/utils/alerts');
                    await alertDialog({ title: 'Link copied', message: 'Post link has been copied to clipboard' });
                }
            } else {
                await Share.share({
                    message: `${shareMessage}\n\n${postUrl}`,
                    url: postUrl,
                    title: `${name} on Mention`
                });
            }
        } catch (error) {
            console.error('Error sharing post:', error);
            try { 
                const { alertDialog } = await import('@/utils/alerts');
                await alertDialog({ title: 'Error', message: 'Failed to share post' }); 
            } catch {
                Alert.alert('Error', 'Failed to share post');
            }
        }
    }, [post]);

    return sharePost;
}

