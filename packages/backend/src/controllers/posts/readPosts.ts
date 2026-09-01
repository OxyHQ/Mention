/**
 * The unauthenticated-shaped post reads: the paged list, one post by id, a
 * post's correction history, and the hashtag/topic listings.
 *
 * Every response is hydrated by `PostHydrationService`; nothing here builds a
 * post DTO by hand.
 */

import { Response } from 'express';
import { and, arrayContains, eq, type SQL } from 'drizzle-orm';
import { posts as postsTable } from '../../db/schema/posts';
import { CHRONO_DESC, findPostRecords, loadPostRecord } from '../../db/posts/postRepository';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { PostCorrectionsResponse } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { queryInt, queryString } from '../../utils/queryParams';
import { topicSlugSql } from '../../utils/postTopicMatch';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { listPostCorrections } from '../../db/posts/postCorrectionsRepository';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './postPageBounds';

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const currentUserId = req.user?.id;

    const posts = await findPostRecords(
      and(eq(postsTable.visibility, 'public'), eq(postsTable.status, 'published')),
      { orderBy: CHRONO_DESC, limit, offset: (page - 1) * limit },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching posts', error);
    res.status(500).json({ message: 'Error fetching posts' });
  }
};

// Get post by ID
export const getPostById = async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    // This route is public (anonymous discovery). No id-shape guard: `posts.id`
    // is `text` holding an ObjectId hex for pre-cutover rows and a uuid v7 for
    // everything after, so a validity check would 404 every post created since
    // the cutover. An unknown id simply matches no row, which is the same 404.
    const postId = String(req.params.id);

    const post = await loadPostRecord(postId);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydrated = await postHydrationService.hydratePosts([post], {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 2,
      includeLinkMetadata: true,
      // Single-post detail read — the surface that renders the quote count.
      includeQuoteCounts: true,
      // The route loads by id with no status filter (above), so this is the
      // surface where somebody asks for a post their feed would never have
      // shown them — including a channel's queued story, asked for by one of
      // the people who runs the channel. Hydration spends this only when the
      // post is actually withheld AND an account authored it; an ordinary post
      // detail read asks Oxy nothing extra.
      operatedAccountReader: createUserScopedOxyServices(req),
    });

    const hydratedPost = hydrated[0];
    if (!hydratedPost) {
      return res.status(404).json({ message: 'Post not available' });
    }

    res.json(hydratedPost);
  } catch (error) {
    logger.error('Error fetching post', error);
    res.status(500).json({ message: 'Error fetching post' });
  }
};

/**
 * `GET /posts/:id/corrections` — a post's public correction trail.
 *
 * The trail is readable exactly when the POST is, and that is enforced by
 * hydrating the post for this viewer and 404ing when hydration drops it —
 * reusing the one ACL rather than restating it. A second implementation of "may
 * this viewer see this post" is a second answer, and the one that is wrong is
 * wrong in the direction of serving superseded bodies of a post the viewer was
 * refused.
 *
 * Public like `getPostById`, for the same reason: a publication's corrections
 * are addressed to whoever read the post, and most of them are not signed in.
 *
 * The response is served straight from the trail rather than from the summary on
 * the post, so `total` and the rows come from one read and cannot disagree about
 * a correction made between two of them.
 */
export const getPostCorrections = async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.id);
    const post = await loadPostRecord(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydrated = await postHydrationService.hydratePosts([post], {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      // The trail is exactly as readable as the post, so it has to be able to
      // reach the same verdict — a channel's operators included, on a post
      // moderation has since restricted.
      operatedAccountReader: createUserScopedOxyServices(req),
    });
    if (hydrated.length === 0) {
      return res.status(404).json({ message: 'Post not available' });
    }

    const corrections = await listPostCorrections(postId);
    const response: PostCorrectionsResponse = {
      postId,
      // The post's own counter, NOT `corrections.length`: retention drops
      // intermediate bodies, and a total taken from the surviving rows would
      // report a publication as having corrected itself fewer times than it did.
      total: post.correctionCount,
      corrections,
    };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post corrections', { postId: String(req.params.id), error });
    return res.status(500).json({ message: 'Error fetching post corrections' });
  }
};

/**
 * The hashtag discovery predicate.
 *
 * Exported (with {@link buildPostsByTopicFilter}) so the visibility scope can be
 * asserted without booting the controller's server import chain. Both return a
 * predicate only — the cursor is applied by the handler, because the chronological
 * keyset needs an `await` (a legacy cursor carrying no timestamp is resolved by
 * one primary-key lookup) and a pure builder cannot make it.
 */
export function buildPostsByHashtagFilter(hashtag: string): SQL {
  return and(
    // `@>` on the `text[]`, GIN-indexed — the analogue of Mongo matching a
    // multikey array by element equality.
    arrayContains(postsTable.hashtags, [hashtag.toLowerCase()]),
    eq(postsTable.status, 'published'),
    eq(postsTable.visibility, 'public'),
  ) as SQL;
}

export const getPostsByHashtag = async (req: AuthRequest, res: Response) => {
  try {
    const hashtag = String(req.params.hashtag);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const keyset = await chronoCursorSql(cursor);
    const posts = await findPostRecords(
      keyset ? and(buildPostsByHashtagFilter(hashtag), keyset) : buildPostsByHashtagFilter(hashtag),
      { orderBy: chronoOrderBy(), limit: limit + 1 },
    );

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const anchor = hasMore ? postsToReturn[postsToReturn.length - 1] : undefined;
    const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      items: hydratedPosts,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by hashtag', error);
    res.status(500).json({ message: 'Error fetching posts by hashtag' });
  }
};

/**
 * Build the topic-page query filter. Matches a published post whose canonical
 * registry-linked `postClassification.topicRefs.name` OR slug-only
 * `postClassification.topics` equals the normalized (lowercased) topic — the two
 * forms of the one canonical topic list (Stage-B AI refs and the Stage-A
 * rule-based slug baseline). Topic discovery is a public surface, so the
 * filter is constrained to public posts. Topics are stored lowercase, so the
 * lookup is lowercased for index efficiency. Exported for unit testing the canonical `$or`
 * contract without booting the controller's server import chain.
 */
export function buildPostsByTopicFilter(topicName: string): SQL {
  return and(
    topicSlugSql(topicName),
    eq(postsTable.status, 'published'),
    eq(postsTable.visibility, 'public'),
  ) as SQL;
}

// Get posts by classified topic or entity name
export const getPostsByTopic = async (req: AuthRequest, res: Response) => {
  try {
    const topicName = String(req.params.topic);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const keyset = await chronoCursorSql(cursor);
    const posts = await findPostRecords(
      keyset ? and(buildPostsByTopicFilter(topicName), keyset) : buildPostsByTopicFilter(topicName),
      { orderBy: chronoOrderBy(), limit: limit + 1 },
    );

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const anchor = hasMore ? postsToReturn[postsToReturn.length - 1] : undefined;
    const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      topic: topicName,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by topic', error);
    res.status(500).json({ message: 'Error fetching posts by topic' });
  }
};
