import { useCallback } from 'react';
import { Share, Platform } from 'react-native';
import { queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { logger } from '@/lib/logger';
import { show as toast } from '@oxyhq/bloom/toast';
import { queryClient } from '@/lib/queryClient';

interface SharePostUser {
    id?: string;
    _id?: string;
    displayName?: string;
    username?: string;
    handle?: string;
}

interface SharePost {
    id?: string;
    content?: string | { text?: string };
    text?: string;
    user?: SharePostUser;
}

export function usePostShare(post: SharePost | null | undefined) {
    const sharePost = useCallback(async () => {
        if (!post) return;

        try {
            const postUrl = `https://mention.earth/p/${post.id ?? ''}`;
            const content = typeof post.content === 'string' ? { text: post.content } : (post.content ?? {});
            const contentText = content.text ?? post.text ?? '';
            const user: SharePostUser = post.user ?? {};
            const id = String(user.id ?? user._id ?? '');
            const name = post.user ? post.user.displayName : 'Someone';

            let handle = user.handle || user.username || '';
            if (!handle && id) {
                try {
                    const cached = queryClient.getQueryData<User>(queryKeys.users.detail(id));
                    handle = cached?.username || '';
                } catch (lookupError) {
                    logger.debug('User lookup failed during share', { error: lookupError });
                }
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
            logger.error('Error sharing post', { error });
            toast('Failed to share post', { type: 'error' });
        }
    }, [post]);

    return sharePost;
}
