import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';

const router = Router();

// Public routes
router.get('/feed', feedController.getFeed.bind(feedController));
router.get('/explore', feedController.getExploreFeed.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));

// Debug route (no auth required for testing)
router.get('/debug', feedController.debugPosts.bind(feedController));

// User profile feed routes
router.get('/user/:userId', feedController.getUserProfileFeed.bind(feedController));

// Protected routes (authentication handled by server middleware)
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 