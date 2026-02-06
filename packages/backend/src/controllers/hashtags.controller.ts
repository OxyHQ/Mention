import { Request, Response, NextFunction } from 'express';
import Hashtag from '../models/Hashtag';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';

export class HashtagsController {
    async searchHashtags(req: Request, res: Response, next: NextFunction) {
        try {
            const { query } = req.body;

            if (!query || typeof query !== 'string') {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: 'Search query is required'
                });
            }

            // Search for hashtags that match the query
            const hashtags = await Hashtag.find({
                name: { $regex: query, $options: 'i' }
            })
            .select('name count')
            .sort({ count: -1 })
            .limit(5);

            return res.json({
                data: hashtags.map(hashtag => hashtag.name)
            });
        } catch (error: any) {
            logger.error('[HashtagsController] Error in searchHashtags:', {
                error: error.message,
                stack: error.stack
            });
            return res.status(500).json({
                error: 'Server error',
                message: `Error searching hashtags: ${error.message}`
            });
        }
    }
}

export default new HashtagsController(); 