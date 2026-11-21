import { useCallback } from 'react';
import { User } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { toast } from '@oxy.so/bloom/toast';
import i18n from '@/lib/i18n';
import { shareLink } from '@/utils/shareLink';
import { postPermalink } from '@/utils/postPermalink';
import { toReaderText } from '@mention/shared-types/textEntities';

interface SharePostUser {
  id?: string;
  _id?: string;
  name?: { displayName?: string };
  username?: string;
  isFederated?: boolean;
  instance?: string;
  federation?: { domain?: string };
}

interface SharePost {
  id?: string;
  content?: string | { text?: string };
  text?: string;
  user?: SharePostUser;
}

/**
 * Share a post through the platform sheet (native) or Web Share / clipboard.
 * A plain function so a feed row can call it on press without mounting a hook.
 */
export async function sharePost(post: SharePost | null | undefined): Promise<void> {
  if (!post) return;

  try {
    const postUrl = postPermalink(post.id ?? '');
    const content =
      typeof post.content === 'string' ? { text: post.content } : (post.content ?? {});
    const contentText = toReaderText(content.text ?? post.text ?? '');
    const user: SharePostUser = post.user ?? {};
    const id = String(user.id ?? user._id ?? '');
    const name = user.name?.displayName || 'Someone';

    const handle = getNormalizedUserHandle(user) || (id ? User.get(id)?.username : '') || '';

    const shareMessage = contentText
      ? `${name}${handle ? ` (@${handle})` : ''}: ${contentText}`
      : `${name}${handle ? ` (@${handle})` : ''} shared a post`;

    await shareLink({
      title: `${name} on Mention`,
      message: shareMessage,
      url: postUrl,
      copiedToast: i18n.t('widgetMenu.linkCopied'),
      errorToast: i18n.t('widgetMenu.shareFailed'),
    });
  } catch (error) {
    logger.error('Error sharing post', error);
    toast(i18n.t('widgetMenu.shareFailed'), { type: 'error' });
  }
}

export function usePostShare(post: SharePost | null | undefined) {
  return useCallback(() => sharePost(post), [post]);
}
