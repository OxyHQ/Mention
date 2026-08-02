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
import { postViewRateLimiter, statisticsRateLimiter } from "../middleware/security";

const router = express.Router();

// Rate-limit every statistics endpoint (200 req/min, keyed by user with IP
// fallback) — same ROUTER-level posture as `notifications.ts`, which carries the
// same CodeQL finding, and for the same reason: every handler here reaches Mongo,
// so the surface is the file, not the one route the dataflow happened to reach.
//
// Not production-gated (unlike `posts.ts` / `feed.routes.ts`): `RedisStore`
// falls back to `{ totalHits: 1 }` when Redis is absent, so this degrades open on
// a dev machine by itself.
router.use(statisticsRateLimiter);

// All routes on THIS router require authentication (handled by the oxy.auth()
// gate applied to the authenticated API group in appRoutes.ts).
router.get("/user", getUserStatistics);
router.get("/post/:postId", getPostInsights);
// The one WRITE here, and the only route that touches Mongo on every call, so it
// carries a second, tighter bound of its own on top of the router's. See
// `postViewRateLimiter` for the ceiling and why it is not the feed's.
router.post("/post/:postId/view", postViewRateLimiter, trackPostView);
router.get("/followers", getFollowerChanges);
router.get("/engagement", getEngagementRatios);
router.get("/weekly-summary", getWeeklySummary);

// Public statistics — mounted separately on the public group in appRoutes.ts with
// optionalAuth. Exposes another user's PUBLIC posting activity (a per-day
// authored-post heatmap), keyed by the :userId path param, the same posture as
// public profile stats (follower counts, profile design). Privacy is enforced
// inside the handler.
export const publicStatisticsRouter = express.Router();
// Limited too, and this is the one that needs it most: an ANONYMOUS caller can
// reach it, the handler aggregates over a window the caller chooses, and the
// visibility check it runs first is itself a `UserSettings` lookup — so even a
// request that returns an empty activity set has already cost two queries.
publicStatisticsRouter.use(statisticsRateLimiter);
publicStatisticsRouter.get("/user/:userId/activity", getUserActivity);

export default router;
