import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { feedController } from '../controllers/feed.controller';
import { mtnFeedController } from '../mtn/controllers/feed.controller';
import { feedPreferencesController } from '../mtn/controllers/feedPreferences.controller';
import { feedModulesController } from '../mtn/controllers/feedModules.controller';
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
// Custom-feed builder module catalog (read-only)
// ────────────────────────────────────────────────────────────
router.get('/modules', feedModulesController.list.bind(feedModulesController));

// ────────────────────────────────────────────────────────────
// Server-persisted feed preferences (saved / pinned / ordered feeds)
// ────────────────────────────────────────────────────────────
router.get('/preferences', requireAuth, feedPreferencesController.get.bind(feedPreferencesController));
router.put('/preferences', requireAuth, feedPreferencesController.update.bind(feedPreferencesController));

// ────────────────────────────────────────────────────────────
// Replies
// ────────────────────────────────────────────────────────────
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
router.get('/replies', feedController.getRepliesFeed.bind(feedController));

// ────────────────────────────────────────────────────────────
// Thread continuation spine (author's self-thread, root → c1 → c2 …)
// ────────────────────────────────────────────────────────────
router.get('/thread-continuations/:rootId', feedController.getThreadContinuations.bind(feedController));

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
router.post('/boost', feedController.createBoost.bind(feedController));
router.delete('/:postId/boost', feedController.unboostItem.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 
