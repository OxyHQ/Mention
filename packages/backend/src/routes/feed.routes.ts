import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';

const router = Router();

// Public routes
router.get('/feed', feedController.getFeed.bind(feedController));
router.get('/for-you', feedController.getForYouFeed.bind(feedController));
router.get('/following', feedController.getFollowingFeed.bind(feedController));
router.get('/explore', feedController.getExploreFeed.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
// Add generic replies route for feeds that don't target a single parent
router.get('/replies', feedController.getRepliesFeed.bind(feedController));

// Debug route removed for production

// User profile feed routes
router.get('/user/:userId', feedController.getUserProfileFeed.bind(feedController));
// Single feed item with full transformation
router.get('/item/:id', feedController.getFeedItemById.bind(feedController));

// Protected routes (authentication handled by server middleware)
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.delete('/:postId/repost', feedController.unrepostItem.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));
router.post('/:postId/save', feedController.saveItem.bind(feedController));
router.delete('/:postId/save', feedController.unsaveItem.bind(feedController));

export default router; 
