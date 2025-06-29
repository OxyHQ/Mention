
import { Request, Response, NextFunction } from "express";
import { OxyServices } from "@oxyhq/services/core";

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

    // Check if token is provided
    console.error("Token:", token);

    if (!token) {
      return res.status(401).json({ message: "Access token required" });
    }

    // Use OxyServices to validate the token
    const tempOxyServices = new OxyServices({
      baseURL: "http://localhost:3001", // Replace with your backend URL
    });
    

    const result = await tempOxyServices.authenticateToken(token);

    return {
      success: true,
      userId: result.userId,
      user: result.user
    };
    next();
  } catch (error: any) {
    return res.status(403).json({ message: "Token validation failed", error: error?.message });
  }
};
  
