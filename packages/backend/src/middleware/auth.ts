import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

const OXY_API_URL = process.env.OXY_API_URL || 'http://localhost:3001';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const response = await axios.get(`${OXY_API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const userData = response.data.data || response.data;
    const userId = userData.id || userData._id || userData.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Invalid user data' });
    }

    // Attach user data to request
    (req as any).user = { ...userData, id: userId };
    (req as any).userId = userId;
    (req as any).accessToken = token;

    next();
  } catch (error: any) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    res.status(401).json({ error: 'Authentication failed' });
  }
};
