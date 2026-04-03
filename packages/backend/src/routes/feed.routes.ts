import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';
import { mtnFeedController } from '../mtn/controllers/feed.controller';
import { feedRateLimiter, feedIPRateLimiter, feedThrottle } from '../middleware/security';
import { cachePublicProfile } from '../middleware/cacheControl';

const router = Router();

// Apply rate limiting in production only
if (process.env.NODE_ENV === 'production') {
  router.use(feedIPRateLimiter);
  router.use(feedRateLimiter);
  router.use(feedThrottle);
}

// ────────────────────────────────────────────────────────────
// MTN Protocol routes — unified descriptor-based feed API
// ────────────────────────────────────────────────────────────
router.get('/mtn', mtnFeedController.getFeed.bind(mtnFeedController));
router.get('/mtn/peek', mtnFeedController.peekLatest.bind(mtnFeedController));
router.post('/mtn/interactions', mtnFeedController.recordInteraction.bind(mtnFeedController));

// ────────────────────────────────────────────────────────────
// Replies
// ────────────────────────────────────────────────────────────
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
router.get('/replies', feedController.getRepliesFeed.bind(feedController));

// ────────────────────────────────────────────────────────────
// User profile feed routes
// ────────────────────────────────────────────────────────────
router.get('/user/:userId', cachePublicProfile, feedController.getUserProfileFeed.bind(feedController));
router.get('/user/:userId/pinned', feedController.getPinnedPost.bind(feedController));
router.get('/item/:id', feedController.getFeedItemById.bind(feedController));

// ────────────────────────────────────────────────────────────
// Action routes (protected)
// ────────────────────────────────────────────────────────────
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.delete('/:postId/repost', feedController.unrepostItem.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 
