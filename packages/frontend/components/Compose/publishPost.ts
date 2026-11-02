import type { CreatePostRequest } from '@mention/shared-types';

/**
 * A post and its optional profile repost are separate writes. Once the post is
 * confirmed, a repost error must never cause the post to be sent a second time.
 */
export async function publishPostWithRepost({
  request,
  createPost,
  boostPost,
  shouldRepost,
  isCurrentOwner,
}: {
  request: CreatePostRequest;
  createPost: (request: CreatePostRequest) => Promise<{ id: string }>;
  boostPost: (request: { postId: string }) => Promise<void>;
  shouldRepost: boolean;
  isCurrentOwner: () => boolean;
}): Promise<
  | { postId: string; repost: 'skipped' | 'confirmed' }
  | { postId: string; repost: 'unconfirmed'; error: unknown }
> {
  const { id: postId } = await createPost(request);
  if (shouldRepost && isCurrentOwner()) {
    try {
      await boostPost({ postId });
      return { postId, repost: 'confirmed' };
    } catch (error) {
      return { postId, repost: 'unconfirmed', error };
    }
  }
  return { postId, repost: 'skipped' };
}
