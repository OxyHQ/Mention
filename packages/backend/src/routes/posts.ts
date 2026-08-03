import { Router, Response } from 'express';
import {
  createPost,
  createThread,
  getPosts,
  getPostById,
  updatePost,
  updatePostSettings,
  updatePostLane,
  deletePost,
  publishScheduledPostNow,
  likePost,
  unlikePost,
  savePost,
  unsavePost,
  getPostsByHashtag,
  getPostsByTopic,
  getSavedPosts,
  getBookmarkFolders,
  moveBookmarkToFolder,
  moveBookmarkToFolderByPostId,
  getDrafts,
  getScheduledPosts,
  getNearbyPosts,
  getPostsInArea,
  getNearbyPostsBothLocations,
  getLocationStats,
  getPostLikes,
  getKnownPostLikers,
  getPostBoosts,
  translatePost,
  translateDraft,
  acceptCollabInvite,
  declineCollabInvite,
  stopCollabSharing,
} from '../controllers/posts.controller';
import { getPostEditSource } from '../controllers/postEditSource.controller';
import {
  deletePostgate,
  deleteThreadgate,
  loadPostgateByPostId,
  loadThreadgateByPostId,
  parseDetachedQuoteUris,
  parseThreadgateAllowRules,
  upsertPostgate,
  upsertThreadgate,
} from '../db/gates/gateRepository';
import { createPostUri } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { config } from '../config';
import { laneWriteRateLimiter, postWriteRateLimiter, translationRateLimiter } from '../middleware/security';

const router = Router();

/**
 * The AI-translation routes carry their own limiter on top of the app-wide one in
 * `app.ts`. They are the only routes here where a cheap request buys expensive
 * work — an Alia inference — and translation is free to every user, so nothing
 * else bounds the spend.
 *
 * Production-gated, mirroring `feed.routes.ts`: the limiter is Redis-backed and a
 * dev machine has no Redis.
 */
const translationRateLimiters = config.runtime.isProduction
  ? [translationRateLimiter]
  : [];

/**
 * Creating or editing a post is the network's main spam surface: it fans out to
 * followers, federates, and gets signed onto a chain. Bounded generously — a human
 * composing normally never comes close, and a long thread still fits — because it
 * exists to stop a loop, not to police enthusiasm.
 */
const postWriteRateLimiters = config.runtime.isProduction
  ? [postWriteRateLimiter]
  : [];

/** `PATCH /:id/lane` is a LANE write; see the mount below for why not a post one. */
const laneWriteRateLimiters = config.runtime.isProduction ? [laneWriteRateLimiter] : [];

/**
 * Post reads mounted on the PUBLIC API group with OPTIONAL auth (see appRoutes.ts)
 * so anonymous browsing works — logged-out users, SEO, fediverse discovery.
 * Auth is optional, never required: when a viewer token is present the
 * controllers resolve `req.user` for viewer-conditional gating (sensitive-content
 * filtering, translation language), but its absence must never 401 a public read.
 *
 * Mounted BEFORE the authenticated `router` (below) — so the parameterized
 * `/:id` read here would shadow any literal `/posts/<word>` route on the
 * authenticated router (Express 5 dropped inline param-regex, so `/:id` cannot be
 * constrained to an id shape). Every single-segment read that shares this
 * namespace therefore lives HERE, ordered with the literals first and `/:id`
 * last. Genuinely public reads are DB-filtered to public+published (or ACL-gated
 * in PostHydrationService for `viewerId===undefined`); the private reads
 * (`/drafts`, `/scheduled`, `/saved`) are NOT public — each controller
 * self-guards (401 when `req.user` is absent) and is co-located only to keep it
 * ahead of `/:id`.
 */
export const publicPostsRouter = Router();

// Genuinely public, anon-safe reads.
publicPostsRouter.get('/hashtag/:hashtag', getPostsByHashtag);
publicPostsRouter.get('/topic/:topic', getPostsByTopic);
publicPostsRouter.get('/nearby', getNearbyPosts);
publicPostsRouter.get('/in-area', getPostsInArea);
publicPostsRouter.get('/nearby-all', getNearbyPostsBothLocations);
publicPostsRouter.get('/location-stats', getLocationStats);
publicPostsRouter.get('/', getPosts);

// Private single-segment reads: self-guarded (401 when unauthenticated), here
// only so the public `/:id` below cannot shadow `/posts/drafts` etc.
publicPostsRouter.get('/drafts', getDrafts);
publicPostsRouter.get('/scheduled', getScheduledPosts);
publicPostsRouter.get('/saved', getSavedPosts);

// Social proof on the post-detail screen: the likers the VIEWER follows. Public,
// unlike the `/:id/likes` engagement list below, because it discloses nothing an
// anonymous viewer could not already see — it is scoped to the viewer's own
// follow graph, so signed-out callers get an empty result rather than a 401.
publicPostsRouter.get('/:id/likes/known', getKnownPostLikers);

// Public post detail — parameterized, MUST be registered LAST so every literal
// read above resolves first. Anonymous viewers receive ONLY public+published
// posts from public-profile authors; PostHydrationService returns 404 for
// private / followers-only / unpublished / private-profile posts when the viewer
// is anonymous.
publicPostsRouter.get('/:id', getPostById);

// Protected routes - specific routes first (must be before parameterized routes)
router.post('/', ...postWriteRateLimiters, createPost);
router.post('/thread', ...postWriteRateLimiters, createThread);
router.get('/bookmarks/folders', getBookmarkFolders);
router.patch('/bookmarks/by-post/:postId/folder', moveBookmarkToFolderByPostId);
router.patch('/bookmarks/:id/folder', moveBookmarkToFolder);
// Composer AI pre-fill: translate a draft body that has no post yet. Must stay
// ahead of the `/:id`-parameterized routes.
//
// Rate-limited on its own, unlike everything else here: this is the one route
// where a cheap request buys an EXPENSIVE one. It takes arbitrary text, so
// unlike `/:id/translate` it cannot be cached — every call is an Alia inference,
// and translation is free to every user, so nothing else bounds the spend.
router.post('/translate-draft', ...translationRateLimiters, translateDraft);

// Owner-only raw source for the composer. Hydrated reads cannot be used for an
// edit because their mention placeholders and reader-language choice are already
// resolved for display.
router.get('/:id/edit-source', getPostEditSource);

// Engagement lists stay behind the auth wall: unlike the public reads above,
// they do NOT gate on the parent post's visibility, so exposing them
// anonymously would reveal who liked/boosted a private or followers-only post.
router.get('/:id/likes', getPostLikes);
router.get('/:id/boosts', getPostBoosts);

// Protected routes with parameters
router.post('/:id/collaborators/accept', acceptCollabInvite);
router.post('/:id/collaborators/decline', declineCollabInvite);
router.post('/:id/collaborators/stop-sharing', stopCollabSharing);
router.put('/:id', ...postWriteRateLimiters, updatePost);
router.patch('/:id/settings', ...postWriteRateLimiters, updatePostSettings);
// Moving a post between the author's own lanes is NOT an edit — no edit window
// and no federation. See `updatePostLane`.
//
// It DOES carry the lane WRITE limiter, deliberately not the post-write one: this
// is a lane operation, and putting it on the post-edit budget would conflate
// moving a post between carriageways with rewriting its text — the exact
// distinction that handler's docstring exists to preserve.
router.patch('/:id/lane', ...laneWriteRateLimiters, updatePostLane);
// Publish one of the caller's own scheduled posts ahead of its time.
router.post('/:id/publish', publishScheduledPostNow);
router.delete('/:id', deletePost);
router.post('/:id/like', likePost);
router.delete('/:id/like', unlikePost);
router.post('/:id/save', savePost);
router.delete('/:id/save', unsavePost);
router.post('/:id/translate', ...translationRateLimiters, translatePost);

// Threadgate routes (reply controls)
router.put('/:id/threadgate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = String(req.params.id);
    const postUri = createPostUri(userId, postId);

    // Mongo stored `allow[]` unvalidated; the rules table refuses a `listOnly`
    // rule with no list and a list on any other rule. Rejecting the payload here
    // answers 400 instead of letting a CHECK violation surface as a 500.
    const allow = parseThreadgateAllowRules(req.body?.allow);
    if (!allow) {
      return res.status(400).json({ message: 'Invalid threadgate allow rules' });
    }

    const threadgate = await upsertThreadgate({ postUri, postId, createdBy: userId, allow });

    return res.status(200).json(threadgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to set threadgate', error: String(error) });
  }
});

router.get('/:id/threadgate', async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.id);
    const threadgate = await loadThreadgateByPostId(postId);

    if (!threadgate) {
      return res.status(404).json({ message: 'Threadgate not found' });
    }

    return res.status(200).json(threadgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to get threadgate', error: String(error) });
  }
});

router.delete('/:id/threadgate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = String(req.params.id);
    const threadgate = await loadThreadgateByPostId(postId);

    if (!threadgate) {
      return res.status(404).json({ message: 'Threadgate not found' });
    }

    if (threadgate.createdBy !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await deleteThreadgate(threadgate.id);
    return res.status(200).json({ message: 'Threadgate removed' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete threadgate', error: String(error) });
  }
});

// Postgate routes (quote controls)
router.put('/:id/postgate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = String(req.params.id);
    const postUri = createPostUri(userId, postId);
    const { disableQuotes, detachedQuoteUris } = req.body ?? {};

    if (disableQuotes !== undefined && disableQuotes !== null && typeof disableQuotes !== 'boolean') {
      return res.status(400).json({ message: 'disableQuotes must be a boolean' });
    }
    const uris = parseDetachedQuoteUris(detachedQuoteUris);
    if (!uris) {
      return res.status(400).json({ message: 'detachedQuoteUris must be an array of strings' });
    }

    const postgate = await upsertPostgate({
      postUri,
      postId,
      createdBy: userId,
      disableQuotes: disableQuotes ?? false,
      detachedQuoteUris: uris,
    });

    return res.status(200).json(postgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to set postgate', error: String(error) });
  }
});

router.get('/:id/postgate', async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.id);
    const postgate = await loadPostgateByPostId(postId);

    if (!postgate) {
      return res.status(404).json({ message: 'Postgate not found' });
    }

    return res.status(200).json(postgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to get postgate', error: String(error) });
  }
});

router.delete('/:id/postgate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = String(req.params.id);
    const postgate = await loadPostgateByPostId(postId);

    if (!postgate) {
      return res.status(404).json({ message: 'Postgate not found' });
    }

    if (postgate.createdBy !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await deletePostgate(postgate.id);
    return res.status(200).json({ message: 'Postgate removed' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete postgate', error: String(error) });
  }
});

export default router;
