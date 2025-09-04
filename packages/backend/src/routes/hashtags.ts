import express, { Request, Response } from "express";
import Post from "../models/Post";

const router = express.Router();

// Public routes
// Get all hashtags
router.get("/", async (req: Request, res: Response) => {
  try {
    const posts = await Post.find({ 
      text: { $exists: true, $ne: "" },
      status: 'published'
    }).lean();

    const hashtagCounts: Record<string, { count: number, createdAt: Date, text: string }> = {};
    
    posts.forEach((post) => {
      // Extract hashtags from post text using regex
      const hashtags = (post.content?.text || '').match(/#[a-zA-Z0-9_]+/g) || [];
      hashtags.forEach((hashtag: string) => {
        const tag = hashtag.toLowerCase();
        if (!hashtagCounts[tag]) {
          hashtagCounts[tag] = { 
            count: 0, 
            createdAt: new Date(post.createdAt), 
            text: hashtag.toLowerCase().substring(1) as string 
          };
        }
        hashtagCounts[tag].count += 1;
      });
    });

    const hashtags = Object.entries(hashtagCounts)
      .map(([hashtag, data]) => ({ 
        text: data.text, 
        hashtag, 
        count: data.count, 
        createdAt: data.createdAt 
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({ hashtags });
  } catch (error) {
    console.error('Error fetching hashtags:', error);
    res.status(500).json({ message: "Error fetching hashtags from posts", error });
  }
});

// Search hashtags
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Search query is required'
      });
    }

    // Search for hashtags in post text
    const posts = await Post.find({
      text: { $regex: `#${query}`, $options: 'i' },
      status: 'published'
    }).lean();

    const hashtagCounts: Record<string, number> = {};
    
    posts.forEach((post) => {
      const hashtags = (post.content?.text || '').match(/#[a-zA-Z0-9_]+/g) || [];
      hashtags.forEach((hashtag: string) => {
        if (hashtag.toLowerCase().includes(query.toLowerCase())) {
          hashtagCounts[hashtag] = (hashtagCounts[hashtag] || 0) + 1;
        }
      });
    });

    const results = Object.entries(hashtagCounts)
      .map(([hashtag, count]) => hashtag)
      .sort((a, b) => hashtagCounts[b] - hashtagCounts[a])
      .slice(0, 5);

    return res.json({
      data: results
    });
  } catch (error: any) {
    console.error('Error in searchHashtags:', error);
    return res.status(500).json({
      error: 'Server error',
      message: `Error searching hashtags: ${error.message}`
    });
  }
});

export default router;
