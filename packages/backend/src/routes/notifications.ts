import express, { Request, Response } from "express";
import Notification from "../models/Notification";
import { Server } from 'socket.io';
import { authMiddleware } from '../middleware/auth';

// Extend Request type to include user property
interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

const router = express.Router();

// Apply authentication middleware to all routes
router.use('/', authMiddleware);

// Helper function to emit notification event
const emitNotification = async (req: Request, notification: any) => {
  const io = req.app.get('io') as Server;
  const notificationsNamespace = io.of('/notifications');
  const populated = await notification.populate('actorId', 'username name avatar');
  notificationsNamespace.to(`user:${notification.recipientId}`).emit('notification', populated);
};

// Get notifications for current user
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ 
        message: "Unauthorized: User ID not found",
        error: "AUTH_ERROR" 
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (page < 1) {
      return res.status(400).json({ 
        message: "Invalid page number", 
        error: "INVALID_PAGE" 
      });
    }

    if (limit < 1 || limit > 100) {
      return res.status(400).json({ 
        message: "Invalid limit. Must be between 1 and 100", 
        error: "INVALID_LIMIT" 
      });
    }

    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ recipientId: userId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('actorId', 'username name avatar _id')
        .populate('entityId')
        .lean(),
      Notification.countDocuments({
        recipientId: userId,
        read: false
      })
    ]);

    if (!notifications) {
      return res.status(404).json({ 
        message: "No notifications found",
        error: "NOT_FOUND",
        notifications: [],
        unreadCount: 0,
        hasMore: false
      });
    }

    res.json({
      notifications,
      unreadCount,
      hasMore: notifications.length === limit,
      page,
      limit
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ 
      message: "Error fetching notifications", 
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      notifications: [],
      unreadCount: 0,
      hasMore: false
    });
  }
});

// Create a notification
router.post("/", async (req: Request, res: Response) => {
  try {
    const notification = new Notification(req.body);
    await notification.save();
    await emitNotification(req, notification);
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ message: "Error creating notification", error });
  }
});

// Mark notification as read
router.put("/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: userId },
      { read: true },
      { new: true }
    ).populate('actorId', 'username name avatar');

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationUpdated', notification);

    res.json({ message: "Notification marked as read", notification });
  } catch (error) {
    res.status(500).json({ message: "Error updating notification", error });
  }
});

// Mark all notifications as read
router.put("/read-all", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await Notification.updateMany(
      { recipientId: userId },
      { read: true }
    );

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('allNotificationsRead');

    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: "Error updating notifications", error });
  }
});

// Delete a notification
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      recipientId: userId
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationDeleted', notification._id);

    res.json({ message: "Notification deleted" });
  } catch (error: any) {
    res.status(500).json({ message: "Error deleting notification", error });
  }
});

export default router;