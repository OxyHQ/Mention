import type { HydratedPost } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';

export type PostSettingsPatch = Parameters<typeof feedService.updatePostSettings>[1];

type PostMetadata = NonNullable<HydratedPost['metadata']>;

/**
 * Write a post's settings (pin, hidden counts, who can reply, quotes) and
 * mirror them into every copy of the post. The copies change at once and change
 * back if the write is refused, so a menu row that stays open shows the choice
 * immediately. Resolves whether the write was saved; the caller says so.
 */
export async function savePostSettings(postId: string, patch: PostSettingsPatch): Promise<boolean> {
  const { updatePostEverywhere } = usePostsStore.getState();
  const fields = Object.keys(patch) as (keyof PostSettingsPatch)[];
  let previous: Partial<PostMetadata> = {};
  updatePostEverywhere(postId, (prev) => {
    const metadata = (prev.metadata ?? {}) as Partial<PostMetadata>;
    previous = Object.fromEntries(fields.map((field) => [field, metadata[field]]));
    return { ...prev, metadata: { ...prev.metadata, ...patch } };
  });
  try {
    await feedService.updatePostSettings(postId, patch);
    return true;
  } catch {
    updatePostEverywhere(postId, (prev) => ({
      ...prev,
      metadata: { ...prev.metadata, ...previous },
    }));
    return false;
  }
}
