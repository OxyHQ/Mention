// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { CreatePostRequest } from '@mention/shared-types';

/**
 * A post and its optional profile repost are separate writes. Once the post is
 * confirmed, a repost error must never cause the post to be sent a second time.
 */
export async function publishPostWithRepost({
  request,
  createPost,
  repostPost,
  shouldRepost,
  isCurrentOwner,
}: {
  request: CreatePostRequest;
  createPost: (request: CreatePostRequest) => Promise<{ id: string }>;
  repostPost: (request: { postId: string }) => Promise<void>;
  shouldRepost: boolean;
  isCurrentOwner: () => boolean;
}): Promise<
  | { postId: string; repost: 'skipped' | 'confirmed' }
  | { postId: string; repost: 'unconfirmed'; error: unknown }
> {
  const { id: postId } = await createPost(request);
  if (shouldRepost && isCurrentOwner()) {
    try {
      await repostPost({ postId });
      return { postId, repost: 'confirmed' };
    } catch (error) {
      return { postId, repost: 'unconfirmed', error };
    }
  }
  return { postId, repost: 'skipped' };
}
