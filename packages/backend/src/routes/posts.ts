import { Router } from 'express';
import {
  createPost,
  getPosts,
  getPostById,
  updatePost,
  deletePost,
  likePost,
  unlikePost,
  savePost,
  unsavePost,
  repostPost,
  quotePost,
  getPostsByHashtag,
  getDrafts,
  getScheduledPosts
} from '../controllers/posts.controller';

const router = Router();

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);
router.get('/:id', getPostById);

// Protected routes - specific routes first
router.post('/', createPost);
router.get('/drafts', getDrafts);
router.get('/scheduled', getScheduledPosts);

// Protected routes with parameters
router.put('/:id', updatePost);
router.delete('/:id', deletePost);
router.post('/:id/like', likePost);
router.delete('/:id/like', unlikePost);
router.post('/:id/save', savePost);
router.delete('/:id/save', unsavePost);
router.post('/:id/repost', repostPost);
router.post('/:id/quote', quotePost);

export default router;
