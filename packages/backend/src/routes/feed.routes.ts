import { Router } from 'express';
import { feedController } from '../controllers/feed.controller';

const router = Router();

// Public routes
router.get('/feed', feedController.getFeed.bind(feedController));

// Protected routes (authentication handled by server middleware)
router.post('/reply', feedController.createReply.bind(feedController));
router.post('/repost', feedController.createRepost.bind(feedController));
router.post('/like', feedController.likeItem.bind(feedController));
router.post('/unlike', feedController.unlikeItem.bind(feedController));

export default router; 