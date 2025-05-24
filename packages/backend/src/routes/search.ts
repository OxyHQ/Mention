import express, { Request, Response } from "express";
import Post from "../models/Post";
import { logger } from '../utils/logger';

const router = express.Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const { query, type = "all" } = req.query;
    const searchQuery = { $regex: query as string, $options: "i" };
    
    const results: any = { posts: [] };

    if (type === "all" || type === "posts") {
      results.posts = await Post.find({ 
        $or: [
          { text: searchQuery },
          { hashtags: searchQuery }
        ]
      })
      .sort({ created_at: -1 })
      .limit(10);
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