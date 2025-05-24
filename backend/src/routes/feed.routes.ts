import { Router } from 'express';
import { FeedController } from '../controllers/feed.controller';
import { authMiddleware } from '../middleware/auth';

const router = Router();
const feedController = new FeedController();

// Public routes
router.get('/explore', feedController.getExploreFeed.bind(feedController));
router.get('/hashtag/:hashtag', feedController.getHashtagFeed.bind(feedController));
router.get('/post/:id', feedController.getPostById.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));

// Protected routes - use authMiddleware
router.get('/home', authMiddleware, feedController.getHomeFeed.bind(feedController));
router.get('/user/:userId', authMiddleware, feedController.getUserFeed.bind(feedController));
router.get('/bookmarks', authMiddleware, feedController.getBookmarksFeed.bind(feedController));
router.get('/replies/:parentId', authMiddleware, feedController.getRepliesFeed.bind(feedController));
router.get('/following', authMiddleware, feedController.getFollowingFeed.bind(feedController));

export default router;