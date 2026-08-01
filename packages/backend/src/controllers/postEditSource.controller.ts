import type { Response } from 'express';
import mongoose from 'mongoose';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type {
  PostAuthorshipEntry,
  PostContent,
  PostEditSource,
  PostUser,
  StoredPostContent,
} from '@mention/shared-types/post';
import {
  mentionTextsFromContent,
} from '@mention/shared-types/mentions';
import { reconcileMentionIdsForPost } from '../utils/textProcessing';
import { Post } from '../models/Post';
import { authorVariants } from '../services/postVariants';
import {
  isFallbackUserSummary,
  resolveUserSummaries,
} from '../services/PostHydrationService';
import { logger } from '../utils/logger';

/**
 * Return the owner's raw author source for editing.
 *
 * Public/hydrated post DTOs intentionally replace mention placeholders with
 * Markdown links and may select a reader-language rendition. Reversing that DTO
 * would have to guess both ids and the primary body. This owner-only endpoint
 * instead returns the persisted author variants and an exact mention allowlist.
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
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return res.status(404).json({ message: 'Post not found' });
  }

  try {
    const post = await Post.findOne({ _id: postId, oxyUserId: userId })
      .select('_id content mentions authorship parentPostId')
      .lean();
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const storedContent = (post.content ?? {}) as StoredPostContent;
    const variants = authorVariants(storedContent);
    const legacyText =
      typeof (storedContent as StoredPostContent & { text?: unknown }).text === 'string'
        ? String((storedContent as StoredPostContent & { text?: string }).text)
        : '';

    const content: PostContent = {
      text: variants[0]?.text ?? legacyText,
      ...(variants.length > 0 ? { variants } : {}),
      ...(Array.isArray(storedContent.media) ? { media: storedContent.media } : {}),
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
      id: String(post._id),
      content,
      mentions,
      mentionUsers,
      ...(Array.isArray(post.authorship)
        ? { authorship: post.authorship as PostAuthorshipEntry[] }
        : {}),
      ...(post.parentPostId ? { parentPostId: String(post.parentPostId) } : {}),
    };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post edit source', { postId, error });
    return res.status(500).json({ message: 'Error fetching post edit source' });
  }
};
