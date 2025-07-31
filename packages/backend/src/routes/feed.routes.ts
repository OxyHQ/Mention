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

// Protected routes (authentication handled by server middleware)
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));

export default router; 