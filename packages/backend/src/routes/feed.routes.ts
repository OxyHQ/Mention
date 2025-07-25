import { Router } from 'express';
import { FeedController } from '../controllers/feed.controller';

const router = Router();
const feedController = new FeedController();

// Debug route to test authentication middleware
router.get('/debug', (req, res) => {
  console.log('Debug route - headers:', req.headers);
  console.log('Debug route - auth header:', req.headers.authorization);
  res.json({ message: 'Debug route reached', hasAuth: !!req.headers.authorization });
});

// Public routes
router.get('/explore', feedController.getExploreFeed.bind(feedController));
router.get('/custom', feedController.getCustomFeed.bind(feedController));
router.get('/hashtag/:hashtag', feedController.getHashtagFeed.bind(feedController));
router.get('/post/:id', feedController.getPostById.bind(feedController));
router.get('/media', feedController.getMediaFeed.bind(feedController));
router.get('/quotes', feedController.getQuotesFeed.bind(feedController));
router.get('/reposts', feedController.getRepostsFeed.bind(feedController));
router.get('/posts', feedController.getPostsFeed.bind(feedController));

// Protected routes (with authentication middleware)
router.get('/home', feedController.getHomeFeed.bind(feedController));
router.get('/user/:userId', feedController.getUserFeed.bind(feedController));
router.get('/bookmarks', feedController.getBookmarksFeed.bind(feedController));
router.get('/replies/:parentId', feedController.getRepliesFeed.bind(feedController));
router.get('/following', feedController.getFollowingFeed.bind(feedController));

export default router;