import express, { Response } from "express";
import { AuthRequest } from '../types/auth';
import { searchGifs, getTrendingGifs } from '../services/gifService';
import { logger } from '../utils/logger';

const router = express.Router();

// Search GIFs
router.get("/search", async (req: AuthRequest, res: Response) => {
  try {
    const { q, page = '1', per_page = '20' } = req.query;
    const customerId = req.user?.id || 'anonymous';
    
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ 
        success: false,
        message: 'Search query (q) is required' 
      });
    }

    const result = await searchGifs({
      query: q,
      page: parseInt(page as string, 10),
      perPage: parseInt(per_page as string, 10),
      customerId,
    });

    res.json(result);
  } catch (error: any) {
    logger.error('[GIFs] GIF search error:', error);
    res.status(500).json({ 
      success: false,
      message: "Error searching GIFs", 
      error: error?.message || "Unknown error" 
    });
  }
});

// Get trending GIFs
router.get("/trending", async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', per_page = '20' } = req.query;
    const customerId = req.user?.id || 'anonymous';
    
    const result = await getTrendingGifs({
      page: parseInt(page as string, 10),
      perPage: parseInt(per_page as string, 10),
      customerId,
    });

    res.json(result);
  } catch (error: any) {
    logger.error('[GIFs] GIF trending error:', error);
    res.status(500).json({ 
      success: false,
      message: "Error fetching trending GIFs", 
      error: error?.message || "Unknown error" 
    });
  }
});

export default router;

