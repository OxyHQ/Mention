import express from "express";
import { 
  getAnalytics, 
  updateAnalytics, 
  getHashtagStats, 
  getContentViewers,
  getInteractions,
  getTopPosts,
  getFollowerDetails
} from "../controllers/analytics.controller";
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all routes
router.use('/', authMiddleware);

router.get("/", getAnalytics);
router.post("/update", updateAnalytics);
router.get("/hashtag/:hashtag", getHashtagStats);
router.get("/viewers", getContentViewers);
router.get("/interactions", getInteractions);
router.get("/top-posts", getTopPosts);
router.get("/followers", getFollowerDetails);

export default router;