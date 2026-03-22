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
  repostPost,
  quotePost,
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
  getPostReposts,
  translatePost
} from '../controllers/posts.controller';
import { Threadgate } from '../models/Threadgate';
import { Postgate } from '../models/Postgate';
import { createPostUri } from '@mention/shared-types';
import { AuthRequest } from '../types/auth';

const router = Router();

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);
router.get('/topic/:topic', getPostsByTopic);
router.get('/nearby', getNearbyPosts);
router.get('/in-area', getPostsInArea);
router.get('/nearby-all', getNearbyPostsBothLocations);
router.get('/location-stats', getLocationStats);

// Protected routes - specific routes first (must be before parameterized routes)
router.post('/', createPost);
router.post('/thread', createThread);
router.get('/drafts', getDrafts);
router.get('/scheduled', getScheduledPosts);
router.get('/saved', getSavedPosts);
router.get('/bookmarks/folders', getBookmarkFolders);
router.patch('/bookmarks/:id/folder', moveBookmarkToFolder);

// Routes with specific paths (must be before parameterized routes)
router.get('/:id/likes', getPostLikes);
router.get('/:id/reposts', getPostReposts);

// Public routes with parameters (must be after specific routes)
router.get('/:id', getPostById);

// Protected routes with parameters
router.put('/:id', updatePost);
router.patch('/:id/settings', updatePostSettings);
router.delete('/:id', deletePost);
router.post('/:id/like', likePost);
router.delete('/:id/like', unlikePost);
router.post('/:id/save', savePost);
router.delete('/:id/save', unsavePost);
router.post('/:id/repost', repostPost);
router.post('/:id/quote', quotePost);
router.post('/:id/translate', translatePost);

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
