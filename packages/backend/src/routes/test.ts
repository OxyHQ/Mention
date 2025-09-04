import express, { Response } from "express";
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = express.Router();

router.get("/", async (req: AuthRequest, res: Response) => {
    try {
        res.json({ message: "Test route", user: req.user, userId: req.user?.id });
    } catch (error) {
        logger.error('Test error:', error);
        res.status(500).json({ 
            message: "Error performing test", 
            error: error instanceof Error ? error.message : "Unknown error" 
        });
    }
});

export default router;