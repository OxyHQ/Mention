import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type {
  PostContent,
  PostEditSource,
  PostUser,
} from '@mention/shared-types/post';
import {
  mentionTextsFromContent,
} from '@mention/shared-types/mentions';
import { reconcileMentionIdsForPost } from '../utils/textProcessing';
import { posts } from '../db/schema/posts';
import { findPostRecords, CHRONO_DESC } from '../db/posts/postRepository';
import { authorVariants } from '../services/postVariants';
import {
  isFallbackUserSummary,
  resolveUserSummaries,
} from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { postManagementRefusal } from '../services/postManagementAccess';

/**
 * Return the owner's raw author source for editing.
 *
 * Public/hydrated post DTOs intentionally replace mention placeholders with
 * Markdown links and may select a reader-language rendition. Reversing that DTO
 * would have to guess both ids and the primary body. This owner-only endpoint
 * instead returns the persisted author variants and an exact mention allowlist.
 *
 * ## Two things the Postgres port removed
 *
 * **The `ObjectId.isValid` guard is gone.** It existed only to dodge a Mongoose
 * `CastError`, and the id column is `text` now: a uuid v7 matches its row, a
 * pre-cutover ObjectId hex matches its row, and an id that is neither matches
 * nothing — which is already the 404 the guard was standing in for. Keeping it
 * would 404 every post created after the cutover.
 *
 * **The legacy top-level `content.text` fallback is gone.** It read a field the
 * stored shape has not had since renditions became the only home of the body;
 * `StoredPostContent` does not declare it, and the column does not exist. A post
 * with no author variant now correctly reports an empty body rather than reading
 * a field that cannot be there.
 */
export const getPostEditSource = async (
  req: AuthRequest,
  res: Response,
): Promise<Response | void> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const postId = String(req.params.id);

  try {
    // By id then authorized, matching `updatePost` — this endpoint loads the post
    // INTO the composer, so narrowing the read by `oxy_user_id = userId` while
    // the edit route accepts a channel's writer would let the edit succeed
    // against a post the composer could never open.
    //
    // The endpoint does not become an existence oracle by losing the narrowing:
    // `postManagementRefusal` below answers 404 for a post the caller may not
    // touch, so "not yours" and "does not exist" stay the same reply.
    const [post] = await findPostRecords(eq(posts.id, postId), {
      orderBy: CHRONO_DESC,
      limit: 1,
    });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const refusal = await postManagementRefusal({
      post,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (refusal) {
      return res.status(refusal.status).json({ message: refusal.message });
    }

    const variants = authorVariants(post.content);
    const content: PostContent = {
      text: variants[0]?.text ?? '',
      ...(variants.length > 0 ? { variants } : {}),
      ...(post.content.media ? { media: post.content.media } : {}),
    };
    const mentions = reconcileMentionIdsForPost(
      mentionTextsFromContent(content),
      post.mentions,
    );

    let mentionUsers: PostUser[] = [];
    try {
      const resolved = await resolveUserSummaries(mentions);
      mentionUsers = mentions.flatMap((id) => {
        const summary = resolved.get(id);
        return summary && !isFallbackUserSummary(summary.user)
          ? [summary.user]
          : [];
      });
    } catch (error) {
      // The stable ids and placeholders are sufficient to preserve the edit.
      // Identity resolution only improves display and must never make the source
      // unreadable during an Oxy/Redis outage.
      logger.warn('Failed to resolve mention identities for post edit source', {
        postId,
        error,
      });
    }

    const response: PostEditSource = {
      id: post.id,
      content,
      mentions,
      mentionUsers,
      ...(post.authorship.length > 0 ? { authorship: post.authorship } : {}),
      ...(post.parentPostId ? { parentPostId: post.parentPostId } : {}),
      // The composer needs the publication state to know whether the 30-minute
      // edit window applies at all, and the time so it can restore the schedule
      // instead of silently dropping it when the author saves. `status` is
      // `NOT NULL` here, so it is always sent rather than conditionally.
      status: post.status,
      ...(post.scheduledFor ? { scheduledFor: post.scheduledFor.toISOString() } : {}),
    };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post edit source', { postId, error });
    return res.status(500).json({ message: 'Error fetching post edit source' });
  }
};
