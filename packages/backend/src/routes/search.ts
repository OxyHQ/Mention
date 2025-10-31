import express, { Request, Response } from "express";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import { feedController } from '../controllers/feed.controller';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const { query, type = "all" } = req.query;
    const searchQuery = { $regex: query as string, $options: "i" };
    const currentUserId = req.user?.id;
    
    const results: any = { posts: [] };

    if (type === "all" || type === "posts") {
      const posts = await Post.find({ 
        $or: [
          { 'content.text': searchQuery },
          { hashtags: searchQuery }
        ]
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

      // Transform posts with user profiles and mention transformation
      const transformedPosts = await (feedController as any).transformPostsWithProfiles(posts, currentUserId);
      results.posts = transformedPosts;
    }

    res.json(results);
  } catch (error) {
    logger.error('Search error:', error);
    res.status(500).json({ 
      message: "Error performing search", 
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

export default router;