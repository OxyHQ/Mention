import { Router, Response } from 'express';
import {
  createPost,
  createThread,
  getPosts,
  getPostById,
  updatePost,
  updatePostSettings,
  deletePost,
  likePost,
  unlikePost,
  savePost,
  unsavePost,
  getPostsByHashtag,
  getPostsByTopic,
  getSavedPosts,
  getBookmarkFolders,
  moveBookmarkToFolder,
  getDrafts,
  getScheduledPosts,
  getNearbyPosts,
  getPostsInArea,
  getNearbyPostsBothLocations,
  getLocationStats,
  getPostLikes,
  getPostBoosts,
  translatePost,
  translateDraft,
  acceptCollabInvite,
  declineCollabInvite,
  stopCollabSharing,
} from '../controllers/posts.controller';
import { Threadgate } from '../models/Threadgate';
import { Postgate } from '../models/Postgate';
import { createPostUri } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { postWriteRateLimiter, translationRateLimiter } from '../middleware/security';

const router = Router();

/**
 * The AI-translation routes carry their own limiter on top of the app-wide one in
 * `server.ts`. They are the only routes here where a cheap request buys expensive
 * work — an Alia inference — and translation is free to every user, so nothing
 * else bounds the spend.
 *
 * Production-gated, mirroring `feed.routes.ts`: the limiter is Redis-backed and a
 * dev machine has no Redis.
 */
const translationRateLimiters = process.env.NODE_ENV === 'production'
  ? [translationRateLimiter]
  : [];

/**
 * Creating or editing a post is the network's main spam surface: it fans out to
 * followers, federates, and gets signed onto a chain. Bounded generously — a human
 * composing normally never comes close, and a long thread still fits — because it
 * exists to stop a loop, not to police enthusiasm.
 */
const postWriteRateLimiters = process.env.NODE_ENV === 'production'
  ? [postWriteRateLimiter]
  : [];

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);
router.get('/topic/:topic', getPostsByTopic);
router.get('/nearby', getNearbyPosts);
router.get('/in-area', getPostsInArea);
router.get('/nearby-all', getNearbyPostsBothLocations);
router.get('/location-stats', getLocationStats);

// Protected routes - specific routes first (must be before parameterized routes)
router.post('/', ...postWriteRateLimiters, createPost);
router.post('/thread', ...postWriteRateLimiters, createThread);
router.get('/drafts', getDrafts);
router.get('/scheduled', getScheduledPosts);
router.get('/saved', getSavedPosts);
router.get('/bookmarks/folders', getBookmarkFolders);
router.patch('/bookmarks/:id/folder', moveBookmarkToFolder);
// Composer AI pre-fill: translate a draft body that has no post yet. Must stay
// ahead of the `/:id`-parameterized routes.
//
// Rate-limited on its own, unlike everything else here: this is the one route
// where a cheap request buys an EXPENSIVE one. It takes arbitrary text, so
// unlike `/:id/translate` it cannot be cached — every call is an Alia inference,
// and translation is free to every user, so nothing else bounds the spend.
router.post('/translate-draft', ...translationRateLimiters, translateDraft);

// Routes with specific paths (must be before parameterized routes)
router.get('/:id/likes', getPostLikes);
router.get('/:id/boosts', getPostBoosts);

// Public routes with parameters (must be after specific routes)
router.get('/:id', getPostById);

// Protected routes with parameters
router.post('/:id/collaborators/accept', acceptCollabInvite);
router.post('/:id/collaborators/decline', declineCollabInvite);
router.post('/:id/collaborators/stop-sharing', stopCollabSharing);
router.put('/:id', ...postWriteRateLimiters, updatePost);
router.patch('/:id/settings', updatePostSettings);
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
    const { allow } = req.body;

    const threadgate = await Threadgate.findOneAndUpdate(
      { postUri },
      { postUri, postId, allow: allow || [], createdBy: userId },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json(threadgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to set threadgate', error: String(error) });
  }
});

router.get('/:id/threadgate', async (req: AuthRequest, res: Response) => {
  try {
    const postId = req.params.id;
    const threadgate = await Threadgate.findOne({ postId });

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

    const postId = req.params.id;
    const threadgate = await Threadgate.findOne({ postId });

    if (!threadgate) {
      return res.status(404).json({ message: 'Threadgate not found' });
    }

    if (threadgate.createdBy !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await Threadgate.deleteOne({ _id: threadgate._id });
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
    const { disableQuotes, detachedQuoteUris } = req.body;

    const postgate = await Postgate.findOneAndUpdate(
      { postUri },
      {
        postUri,
        postId,
        disableQuotes: disableQuotes ?? false,
        detachedQuoteUris: detachedQuoteUris ?? [],
        createdBy: userId,
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json(postgate);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to set postgate', error: String(error) });
  }
});

router.get('/:id/postgate', async (req: AuthRequest, res: Response) => {
  try {
    const postId = req.params.id;
    const postgate = await Postgate.findOne({ postId });

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

    const postId = req.params.id;
    const postgate = await Postgate.findOne({ postId });

    if (!postgate) {
      return res.status(404).json({ message: 'Postgate not found' });
    }

    if (postgate.createdBy !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await Postgate.deleteOne({ _id: postgate._id });
    return res.status(200).json({ message: 'Postgate removed' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete postgate', error: String(error) });
  }
});

export default router;
