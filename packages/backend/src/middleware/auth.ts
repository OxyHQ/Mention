import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        message: 'Access token required',
        error: 'AUTH_ERROR' 
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (!process.env.ACCESS_TOKEN_SECRET) {
      console.error('ACCESS_TOKEN_SECRET not configured');
      return res.status(500).json({ 
        message: 'Server configuration error',
        error: 'CONFIG_ERROR' 
      });
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET) as { id: string };
    
    if (!decoded || !decoded.id) {
      return res.status(401).json({ 
        message: 'Invalid access token',
        error: 'INVALID_TOKEN' 
      });
    }

    req.user = decoded;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ 
        message: 'Access token expired',
        error: 'TOKEN_EXPIRED' 
      });
    }
    
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ 
        message: 'Invalid access token',
        error: 'INVALID_TOKEN' 
      });
    }
    
    return res.status(500).json({ 
      message: 'Authentication failed',
      error: 'AUTH_ERROR' 
    });
  }
};
