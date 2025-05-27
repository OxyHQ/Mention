
import { Request, Response, NextFunction } from "express";
import { OxyServices } from "@oxyhq/services";

interface AuthenticatedRequest extends Request {
  userId?: string;
  accessToken?: string;
}

/**
 * Oxy authentication middleware for Express.js
 * Validates the Bearer token using OxyServices and attaches userId and accessToken to the request
 */
export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN
    if (!token) {
      return res.status(401).json({ message: "Access token required" });
    }

    // Use OxyServices to validate the token
    const tempOxyServices = new OxyServices({
      baseURL: "http://localhost:3001", // Replace with your Oxy backend URL
    });
    tempOxyServices.setTokens(token, "");
    const isValid = await tempOxyServices.validate();
    const userId = await tempOxyServices.getCurrentUserId();
    // Debug logging for troubleshooting
    if (process.env.NODE_ENV !== 'production') {
      console.log('[OxyAuth] Token:', token);
      console.log('[OxyAuth] isValid:', isValid);
      console.log('[OxyAuth] userId:', userId);
    }
    if (!isValid) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }
    if (!userId) {
      return res.status(403).json({ message: "Invalid token payload" });
    }
    req.userId = userId;
    req.accessToken = token;
    next();
  } catch (error: any) {
    return res.status(403).json({ message: "Token validation failed", error: error?.message });
  }
};
  
