import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';
import { feedRateLimiter, feedIPRateLimiter, feedThrottle } from '../middleware/security';

const router = Router();

// Apply multi-layer rate limiting to all feed routes
// Layer 1: Per-IP rate limiting (10 requests/second)
router.use(feedIPRateLimiter);
// Layer 2: Per-user rate limiting (100 requests/minute for authenticated, 50 for unauthenticated)
router.use(feedRateLimiter);
// Layer 3: Throttling for expensive operations (For You, Explore feeds)
router.use(feedThrottle);

// Public routes (accessible without authentication)
router.get('/feed', feedController.getFeed.bind(feedController));
router.get('/for-you', feedController.getForYouFeed.bind(feedController));
router.get('/explore', feedController.getExploreFeed.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
// Add generic replies route for feeds that don't target a single parent
router.get('/replies', feedController.getRepliesFeed.bind(feedController));

// User profile feed routes
router.get('/user/:userId', feedController.getUserProfileFeed.bind(feedController));
// Single feed item with full transformation
router.get('/item/:id', feedController.getFeedItemById.bind(feedController));

// Protected routes (require authentication)
// Note: These routes should be on the authenticated router in server.ts
// Keeping them here for organization, but they'll be protected by oxy.auth() middleware
router.get('/following', feedController.getFollowingFeed.bind(feedController)); // Requires auth
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.delete('/:postId/repost', feedController.unrepostItem.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 
