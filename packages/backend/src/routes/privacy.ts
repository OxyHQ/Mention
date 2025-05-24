import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import User from "../models/User";
import Block from "../models/Block";
import { authMiddleware } from '../middleware/auth';
import { z } from "zod";
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

const router = express.Router();
router.use(authMiddleware);

const privacySettingsSchema = z.object({
  isPrivateAccount: z.boolean().optional(),
  hideOnlineStatus: z.boolean().optional(),
  hideLastSeen: z.boolean().optional(),
  profileVisibility: z.boolean().optional(),
  postVisibility: z.boolean().optional(),
  twoFactorEnabled: z.boolean().optional(),
  loginAlerts: z.boolean().optional(),
  blockScreenshots: z.boolean().optional(),
  secureLogin: z.boolean().optional(),
  biometricLogin: z.boolean().optional(),
  showActivity: z.boolean().optional(),
  allowTagging: z.boolean().optional(),
  allowMentions: z.boolean().optional(),
  hideReadReceipts: z.boolean().optional(),
  allowComments: z.boolean().optional(),
  allowDirectMessages: z.boolean().optional(),
  dataSharing: z.boolean().optional(),
  locationSharing: z.boolean().optional(),
  analyticsSharing: z.boolean().optional(),
  sensitiveContent: z.boolean().optional(),
  autoFilter: z.boolean().optional(),
  muteKeywords: z.boolean().optional(),
});

// Get privacy settings
const getPrivacySettings = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select('privacySettings');
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user.privacySettings);
  } catch (error) {
    logger.error('Error fetching privacy settings:', error);
    res.status(500).json({ 
      message: "Error fetching privacy settings",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

// Update privacy settings
const updatePrivacySettings = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const settings = privacySettingsSchema.parse(req.body);
    const authUser = (req as AuthenticatedRequest).user;

    if (authUser?.id !== id) {
      return res.status(403).json({ message: "Not authorized to update these settings" });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: { privacySettings: settings } },
      { new: true }
    ).select('privacySettings');

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user.privacySettings);
  } catch (error) {
    logger.error('Error updating privacy settings:', error);
    res.status(500).json({ 
      message: "Error updating privacy settings",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

// Get blocked users
const getBlockedUsers = async (req: Request, res: Response) => {
  try {
    const authUser = (req as AuthenticatedRequest).user;
    const blocks = await Block.find({ userId: authUser?.id })
      .populate('blockedId', 'username avatar')
      .lean();
    res.json(blocks);
  } catch (error) {
    logger.error('Error fetching blocked users:', error);
    res.status(500).json({ 
      message: "Error fetching blocked users",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

// Block a user
const blockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const authUser = (req as AuthenticatedRequest).user;

    if (!authUser?.id || authUser.id === targetId) {
      return res.status(400).json({ message: "Invalid block request" });
    }

    const existingBlock = await Block.findOne({
      userId: authUser.id,
      blockedId: targetId
    });

    if (existingBlock) {
      return res.status(409).json({ message: "User already blocked" });
    }

    const block = new Block({
      userId: authUser.id,
      blockedId: targetId
    });
    await block.save();

    res.json({ message: "User blocked successfully" });
  } catch (error) {
    logger.error('Error blocking user:', error);
    res.status(500).json({ 
      message: "Error blocking user",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

// Unblock a user
const unblockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const authUser = (req as AuthenticatedRequest).user;

    if (!authUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const result = await Block.deleteOne({
      userId: authUser.id,
      blockedId: targetId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Block not found" });
    }

    res.json({ message: "User unblocked successfully" });
  } catch (error) {
    logger.error('Error unblocking user:', error);
    res.status(500).json({ 
      message: "Error unblocking user",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

router.get("/:id/privacy", getPrivacySettings);
router.patch("/:id/privacy", updatePrivacySettings);
router.get("/blocked", getBlockedUsers);
router.post("/blocked/:targetId", blockUser);
router.delete("/blocked/:targetId", unblockUser);

export default router;
