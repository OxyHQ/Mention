import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';
import { mtnFeedController } from '../mtn/controllers/feed.controller';
import { feedRateLimiter, feedIPRateLimiter, feedThrottle } from '../middleware/security';
import { cachePublicShort, cachePublicProfile, cachePrivateNoStore } from '../middleware/cacheControl';

const router = Router();

// Apply multi-layer rate limiting to all feed routes
// Layer 1: Per-IP rate limiting (10 requests/second)
router.use(feedIPRateLimiter);
// Layer 2: Per-user rate limiting (100 requests/minute for authenticated, 50 for unauthenticated)
router.use(feedRateLimiter);
// Layer 3: Throttling for expensive operations (For You, Explore feeds)
router.use(feedThrottle);

// ────────────────────────────────────────────────────────────
// MTN Protocol routes — unified descriptor-based feed API
// ────────────────────────────────────────────────────────────
router.get('/mtn', mtnFeedController.getFeed.bind(mtnFeedController));
router.get('/mtn/peek', mtnFeedController.peekLatest.bind(mtnFeedController));
router.post('/mtn/interactions', mtnFeedController.recordInteraction.bind(mtnFeedController));

// ────────────────────────────────────────────────────────────
// Legacy routes (kept during migration, will be removed)
// ────────────────────────────────────────────────────────────
router.get('/feed', feedController.getFeed.bind(feedController));
router.get('/for-you', cachePrivateNoStore, feedController.getForYouFeed.bind(feedController));
router.get('/explore', cachePublicShort, feedController.getExploreFeed.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
router.get('/replies', feedController.getRepliesFeed.bind(feedController));

// User profile feed routes
router.get('/user/:userId', cachePublicProfile, feedController.getUserProfileFeed.bind(feedController));
router.get('/user/:userId/pinned', feedController.getPinnedPost.bind(feedController));
router.get('/item/:id', feedController.getFeedItemById.bind(feedController));

// Protected routes
router.get('/following', cachePrivateNoStore, feedController.getFollowingFeed.bind(feedController));
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.delete('/:postId/repost', feedController.unrepostItem.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 
