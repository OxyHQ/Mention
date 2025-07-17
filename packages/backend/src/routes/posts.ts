import { Router } from 'express';
import {
  createPost,
  getPosts,
  getPostById,
  updatePost,
  deletePost,
  likePost,
  unlikePost,
  bookmarkPost,
  unbookmarkPost,
  repostPost,
  quotePost,
  getPostsByHashtag,
  getDrafts,
  getScheduledPosts
} from '../controllers/posts.controller';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);
router.get('/:id', getPostById);

// Apply authentication middleware to all subsequent routes
router.use('/', authMiddleware);

// Protected routes - specific routes first
router.post('/', createPost);
router.get('/drafts', getDrafts);
router.get('/scheduled', getScheduledPosts);

// Protected routes with parameters
router.put('/:id', updatePost);
router.delete('/:id', deletePost);
router.post('/:id/like', likePost);
router.delete('/:id/like', unlikePost);
router.post('/:id/bookmark', bookmarkPost);
router.delete('/:id/bookmark', unbookmarkPost);
router.post('/:id/repost', repostPost);
router.post('/:id/quote', quotePost);

export default router;
