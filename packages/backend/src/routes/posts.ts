import { Router } from 'express';
import {
  createPost,
  createThread,
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
  getSavedPosts,
  getDrafts,
  getScheduledPosts,
  getNearbyPosts,
  getPostsInArea,
  getNearbyPostsBothLocations,
  getLocationStats
} from '../controllers/posts.controller';

const router = Router();

// Public routes
router.get('/', getPosts);
router.get('/hashtag/:hashtag', getPostsByHashtag);
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

// Public routes with parameters (must be after specific routes)
router.get('/:id', getPostById);

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
