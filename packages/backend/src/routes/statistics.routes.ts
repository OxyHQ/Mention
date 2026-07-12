import express from "express";
import {
  getUserStatistics,
  getUserActivity,
  getPostInsights,
  trackPostView,
  getFollowerChanges,
  getEngagementRatios,
  getWeeklySummary
} from "../controllers/statistics.controller";

const router = express.Router();

// All routes on THIS router require authentication (handled by the oxy.auth()
// gate applied to authenticatedApiRouter in server.ts).
router.get("/user", getUserStatistics);
router.get("/post/:postId", getPostInsights);
router.post("/post/:postId/view", trackPostView);
router.get("/followers", getFollowerChanges);
router.get("/engagement", getEngagementRatios);
router.get("/weekly-summary", getWeeklySummary);

// Public statistics — mounted separately on the public router in server.ts with
// optionalAuth. Exposes another user's PUBLIC posting activity (a per-day
// authored-post heatmap), keyed by the :userId path param, the same posture as
// public profile stats (follower counts, profile design). Privacy is enforced
// inside the handler.
export const publicStatisticsRouter = express.Router();
publicStatisticsRouter.get("/user/:userId/activity", getUserActivity);

export default router;

