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
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);

// Protected routes - specific routes first
router.post('/', authenticateToken, createPost);
router.get('/drafts', authenticateToken, getDrafts);
router.get('/scheduled', authenticateToken, getScheduledPosts);

// Protected routes with parameters
router.get('/:id', getPostById);
router.put('/:id', authenticateToken, updatePost);
router.delete('/:id', authenticateToken, deletePost);
router.post('/:id/like', authenticateToken, likePost);
router.delete('/:id/like', authenticateToken, unlikePost);
router.post('/:id/bookmark', authenticateToken, bookmarkPost);
router.delete('/:id/bookmark', authenticateToken, unbookmarkPost);
router.post('/:id/repost', authenticateToken, repostPost);
router.post('/:id/quote', authenticateToken, quotePost);

export default router;
