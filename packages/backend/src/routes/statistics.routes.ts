import express from "express";
import {
  getUserStatistics,
  getPostInsights,
  trackPostView,
  getFollowerChanges,
  getEngagementRatios,
  getWeeklySummary
} from "../controllers/statistics.controller";

const router = express.Router();

// All statistics routes require authentication (handled by oxy.auth() middleware in server.ts)
router.get("/user", getUserStatistics);
router.get("/post/:postId", getPostInsights);
router.post("/post/:postId/view", trackPostView);
router.get("/followers", getFollowerChanges);
router.get("/engagement", getEngagementRatios);
router.get("/weekly-summary", getWeeklySummary);

export default router;

