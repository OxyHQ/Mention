import type { HydratedPost } from '@mention/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { confirmDialog } from '@/utils/alerts';
import { languageLabel } from '@/utils/postLanguages';

const logger = createLogger('serverDraftActions');

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The languages a server draft was ALSO written in, beside the one it is shown in.
 *
 * Hydration already picked the rendition for this reader and put it in
 * `content.text` (`textLang` says which), so a row shows that and only mentions
 * the rest. Author variants only: a machine translation is not something the
 * author wrote, and saying the draft "is also in" it would be false.
 */
export function otherDraftLanguages(post: HydratedPost): string[] {
  const shown = post.content?.textLang;
  const labels = (post.content?.variants ?? [])
    .filter((variant) => variant.source === 'author' && variant.tag && variant.tag !== shown)
    .map((variant) => languageLabel(variant.tag as string));
  return [...new Set(labels)];
}

/**
 * Ask before publishing a server draft, then publish it.
 *
 * Publishing is one-way and PUBLIC — it notifies, federates and signs the post
 * onto the author's chain — so it asks first, like the scheduled "Post now".
 * Shared by the drafts list and the preview so the two say the same thing.
 */
export async function confirmAndPublishDraft(params: {
  post: HydratedPost;
  onPublish: (postId: string) => Promise<void>;
  t: Translate;
}): Promise<boolean> {
  const { post, onPublish, t } = params;
  const confirmed = await confirmDialog({
    title: t('compose.serverDrafts.publishTitle', { defaultValue: 'Publish draft' }),
    message: t('compose.serverDrafts.publishConfirm', {
      defaultValue: 'This draft will be published now, and everyone who can see your posts will see it.',
    }),
    okText: t('compose.serverDrafts.publish', { defaultValue: 'Publish' }),
    cancelText: t('common.cancel'),
  });
  if (!confirmed) return false;

  try {
    await onPublish(post.id);
    toast(t('compose.serverDrafts.published', { defaultValue: 'Draft published' }), { type: 'success' });
    return true;
  } catch (error) {
    logger.error('Error publishing a server draft', error);
    toast(t('compose.serverDrafts.publishError', { defaultValue: 'Could not publish the draft' }), { type: 'error' });
    return false;
  }
}

/** Ask before deleting a server draft, then delete it. Shared like the publish. */
export async function confirmAndDeleteServerDraft(params: {
  post: HydratedPost;
  onDelete: (postId: string) => Promise<void>;
  t: Translate;
}): Promise<boolean> {
  const { post, onDelete, t } = params;
  const confirmed = await confirmDialog({
    title: t('compose.deleteDraft'),
    message: t('compose.serverDrafts.deleteConfirm', {
      defaultValue: 'This draft will be deleted from your account and never published.',
    }),
    okText: t('common.delete'),
    cancelText: t('common.cancel'),
    destructive: true,
  });
  if (!confirmed) return false;

  try {
    await onDelete(post.id);
    toast(t('compose.draftDeleted'), { type: 'success' });
    return true;
  } catch (error) {
    logger.error('Error deleting a server draft', error);
    toast(t('compose.deleteDraftError'), { type: 'error' });
    return false;
  }
}
