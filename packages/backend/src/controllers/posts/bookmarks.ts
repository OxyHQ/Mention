/**
 * The viewer's saved posts: saving and unsaving, the saved list, the folder
 * list, and moving a bookmark between folders.
 */

import { Response } from 'express';
import { and, desc, eq, exists, ilike, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { bookmarks as bookmarksTable } from '../../db/schema/engagement';
import { posts as postsTable } from '../../db/schema/posts';
import { postContentVariants } from '../../db/schema/postContent';
import { CHRONO_DESC, findPostRecords } from '../../db/posts/postRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { userPreferenceService, readInteractionSurface } from '../../services/UserPreferenceService';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { queryInt, queryString } from '../../utils/queryParams';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { emitPostEngagement, POST_ENGAGEMENT_EVENTS } from '../../services/postEngagementBroadcast';
import {
  EngagementPostNotFoundError,
  savePostCommand,
  unsavePostCommand,
} from '../../services/PostEngagementCommandService';
import {
  BookmarkFolderInputError,
  type BookmarkFolderTarget,
  updateBookmarkFolderForViewer,
} from '../../services/BookmarkFolderService';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './postPageBounds';

// Save post
export const savePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const surface = readInteractionSurface(req.body);

    logger.debug('Save request received', { surface });
    const result = await savePostCommand({ userId, postId });

    // Learn only from the relationship transition, not an idempotent retry.
    if (result.changed) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'save', { surface })
        .catch((error) => logger.warn('Failed to record interaction for preferences', error));
    }

    // No `actorId`: the save COUNT is public (it is on every post DTO), but who
    // saved a post is not, and a room is the wrong place to say it. The trade is
    // that this viewer's own other devices cannot tell their own save from a
    // stranger's — they do not need to, since only the count travels here.
    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.SAVED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: { saves: result.post.statsSavesCount },
      });
    }

    res.json({
      message: result.changed ? 'Post saved successfully' : 'Post already saved',
      savesCount: result.post.statsSavesCount,
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error saving post', error);
    res.status(500).json({ message: 'Error saving post' });
  }
};

// Unsave post
export const unsavePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const result = await unsavePostCommand({ userId, postId });

    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.UNSAVED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: { saves: result.post.statsSavesCount },
      });
    }

    // Durable MTN side effects are delivered by the transactional outbox.
    res.json({
      message: result.changed ? 'Post unsaved successfully' : 'Post not saved',
      savesCount: result.post.statsSavesCount,
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error unsaving post', error);
    res.status(500).json({ message: 'Error unsaving post' });
  }
};

// Get saved posts for current user
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const searchQuery = queryString(req.query.search);

    const folderFilter = queryString(req.query.folder);

    // Get saved post IDs for the user, optionally filtered by folder
    const savedPosts = await getDb()
      .select({ postId: bookmarksTable.postId })
      .from(bookmarksTable)
      .where(
        folderFilter
          ? and(eq(bookmarksTable.userId, userId), eq(bookmarksTable.folder, folderFilter))
          : eq(bookmarksTable.userId, userId),
      )
      .orderBy(desc(bookmarksTable.createdAt));

    const postIds = savedPosts.map((saved) => saved.postId);

    // Build query for posts
    // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
    const conditions: SQL[] = [inArray(postsTable.id, postIds)];

    // Add search filter if provided
    if (searchQuery && searchQuery.trim()) {
      const trimmedQuery = searchQuery.trim();
      logger.debug('Applying saved-post search filter', {
        queryLength: trimmedQuery.length,
      });
      // Case-insensitive substring match over the renditions, which is where the
      // bodies live — so a saved post matches by ANY language the author wrote it
      // in. `ILIKE` with the term escaped for its own wildcards (`%`, `_`,
      // backslash), which is the direct analogue of Mongo's escaped `$regex`:
      // without it a saved search for `100%` would match every saved post.
      const escaped = trimmedQuery.replace(/[\\%_]/g, (char) => `\\${char}`);
      conditions.push(
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(postContentVariants)
            .where(
              and(
                eq(postContentVariants.postId, postsTable.id),
                ilike(postContentVariants.body, `%${escaped}%`),
              ),
            ),
        ),
      );
      logger.debug('Built saved-post query', {
        savedPostCount: postIds.length,
        hasSearchFilter: true,
      });
    }

    // Get the actual posts
    const posts = postIds.length === 0
      ? []
      : await findPostRecords(and(...conditions), {
        orderBy: CHRONO_DESC,
        limit,
        offset: (page - 1) * limit,
      });

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
      // Bookmarks are selected by id alone — deliberately, so saving something
      // does not stop working when its visibility changes. That makes this one
      // of the few list endpoints that can hold a withheld post, and dropping a
      // channel operator's own saved entry out of their bookmarks would be a
      // silent loss rather than a refusal they could act on.
      operatedAccountReader: createUserScopedOxyServices(req),
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching saved posts', error);
    res.status(500).json({ message: 'Error fetching saved posts' });
  }
};

// Get bookmark folders for current user
export const getBookmarkFolders = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // `is not null`, never `<> null`: Mongo's `$ne: null` also excluded a MISSING
    // field, while SQL's `<>` against NULL evaluates to NULL and matches nothing,
    // so the literal translation returns an empty folder list for everyone.
    const rows = await getDb()
      .selectDistinct({ folder: bookmarksTable.folder })
      .from(bookmarksTable)
      .where(and(eq(bookmarksTable.userId, userId), isNotNull(bookmarksTable.folder)));
    res.json({ folders: rows.map((row) => row.folder) });
  } catch (error) {
    logger.error('Error fetching bookmark folders', error);
    res.status(500).json({ message: 'Error fetching bookmark folders' });
  }
};

const moveBookmarkFolder = async (
  req: AuthRequest,
  res: Response,
  target: BookmarkFolderTarget,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const bookmark = await updateBookmarkFolderForViewer({
      viewerId: userId,
      target,
      folder: req.body?.folder,
    });

    if (!bookmark) {
      return res.status(404).json({ message: 'Bookmark not found' });
    }

    return res.json({ bookmark });
  } catch (error) {
    if (error instanceof BookmarkFolderInputError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error moving bookmark to folder', error);
    return res.status(500).json({ message: 'Error moving bookmark to folder' });
  }
};

/**
 * Compatibility route for clients that already hold the Bookmark document id.
 */
export const moveBookmarkToFolder = async (req: AuthRequest, res: Response) =>
  moveBookmarkFolder(req, res, {
    kind: 'bookmarkId',
    id: String(req.params.id ?? ''),
  });

/**
 * Preferred app contract: saved-post DTOs expose the post id, not the private
 * Bookmark document id, so update the viewer's relation by `{ userId, postId }`.
 */
export const moveBookmarkToFolderByPostId = async (
  req: AuthRequest,
  res: Response,
) =>
  moveBookmarkFolder(req, res, {
    kind: 'postId',
    id: String(req.params.postId ?? ''),
  });
