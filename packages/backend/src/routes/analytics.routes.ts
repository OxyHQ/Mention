import express from "express";
import {
  getAnalytics,
  updateAnalytics,
  getHashtagStats,
  getTopPosts,
  getFollowerDetails
} from "../controllers/analytics.controller";

const router = express.Router();

router.get("/", getAnalytics);
router.post("/update", updateAnalytics);
router.get("/hashtag/:hashtag", getHashtagStats);
router.get("/top-posts", getTopPosts);
router.get("/followers", getFollowerDetails);

export default router;