import express, { Request, Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import mongoose from 'mongoose';
import Notification from "../models/Notification";
import Post from "../models/Post";
import { Server } from 'socket.io';
import { oxy } from '../../server';
import PushToken from '../models/PushToken';
import { sendPushToUser } from '../utils/push';
import { resolveAvatarUrl } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import type { User } from '@oxyhq/core';

const router = express.Router();

function toPopulatedActor(actor: Partial<User> & { _id?: string }, fallbackId: unknown) {
  const id = String(actor?.id || actor?._id || fallbackId);
  return {
    _id: id,
    username: actor?.username || id,
    displayName: actor?.name?.displayName ?? id,
    avatar: resolveAvatarUrl(typeof actor?.avatar === 'string' ? actor.avatar : undefined),
  };
}

// Helper function to emit notification event
const emitNotification = async (req: Request, notification: any) => {
  const io = req.app.get('io') as Server;
  const notificationsNamespace = io.of('/notifications');
  let actor: any = null;
  try {
    if (notification.actorId && notification.actorId !== 'system') {
      actor = await oxy.getUserById(notification.actorId);
    } else if (notification.actorId === 'system') {
      actor = { id: 'system', username: 'system', name: { displayName: 'System' }, avatar: undefined };
    }
  } catch (e) {
    logger.warn('[Notifications] Failed to resolve actor profile:', e);
  }
  // Attach preview and embedded post for post notifications if applicable
  let preview: string | undefined;
  let embeddedPost: any | undefined;
  try {
    if (notification.type === 'post' && notification.entityType === 'post' && notification.entityId) {
      const post: any = await Post.findById(notification.entityId).lean();
      if (post) {
        const text: string = post?.content?.text || '';
        const trimmed = typeof text === 'string' ? text.trim() : '';
        preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
        [embeddedPost] = await postHydrationService.hydratePosts([post], {
          viewerId: String(notification.recipientId || ''),
          maxDepth: 1,
          includeLinkMetadata: true,
        });
      }
    }
  } catch (e) {
    logger.warn('[Notifications] Failed to build post preview for notification:', e);
  }
  const payload = {
    ...notification.toObject?.() || notification,
    preview,
    post: embeddedPost,
    actorId_populated: actor ? toPopulatedActor(actor, notification.actorId) : undefined
  };
  notificationsNamespace.to(`user:${notification.recipientId}`).emit('notification', payload);
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

    // Use cursor-based pagination for better performance at scale
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20), 10), 1), 50); // Clamp between 1-50

    // Build query with cursor support
    const query: any = { recipientId: userId };
    if (cursor) {
      // Validate cursor is a valid ObjectId
      if (!mongoose.Types.ObjectId.isValid(cursor)) {
        return res.status(400).json({ 
          message: "Invalid cursor format", 
          error: "INVALID_CURSOR" 
        });
      }
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Fetch limit + 1 to determine if there are more results
    const [notificationsRaw, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .populate('entityId', '_id oxyUserId content.text stats metadata.isPinned createdAt')
        .lean(),
      Notification.countDocuments({
        recipientId: userId,
        read: false
      })
    ]);

    if (!notificationsRaw) {
      return res.status(404).json({ 
        message: "No notifications found",
        error: "NOT_FOUND",
        notifications: [],
        unreadCount: 0,
        hasMore: false
      });
    }

  // Resolve unique actor profiles from Oxy to enrich response
    const uniqueActorIds = Array.from(new Set(
      notificationsRaw.map((n: any) => n.actorId).filter(Boolean)
    ));

    const profilesMap = new Map<string, any>();
    await Promise.all(uniqueActorIds.map(async (id: string) => {
      try {
        if (id === 'system') {
          profilesMap.set(id, { id: 'system', username: 'system', name: { displayName: 'System' }, avatar: undefined });
        } else {
          const profile = await oxy.getUserById(id);
          profilesMap.set(id, profile);
        }
      } catch (e) {
        logger.warn(`[Notifications] Failed to resolve actor profile ${id}:`, e);
      }
    }));

    // For 'post' notifications, fetch post docs to provide a short preview and full post data
    const postEntityIds = notificationsRaw
      .filter((n: any) => n && n.type === 'post' && n.entityType === 'post' && n.entityId)
      .map((n: any) => {
        const ent: any = n.entityId;
        if (!ent) return undefined as any;
        if (typeof ent === 'string') return ent;
        if (typeof ent === 'object') {
          if (ent._id) return String(ent._id);
          if (typeof ent.toString === 'function') return ent.toString();
        }
        return String(ent);
      })
      .filter(Boolean) as string[];

    let postPreviewMap = new Map<string, string>();
    let postMap = new Map<string, any>();
    if (postEntityIds.length > 0) {
      try {
        const posts = await Post.find(
          { _id: { $in: postEntityIds } },
          { _id: 1, oxyUserId: 1, content: 1, stats: 1, metadata: 1, createdAt: 1 }
        ).lean();

        // Build preview map
        postPreviewMap = new Map(
          posts.map((p: any) => {
            const text: string = p?.content?.text || '';
            const trimmed = typeof text === 'string' ? text.trim() : '';
            const truncated = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
            return [String(p._id), truncated];
          })
        );

        const hydratedPosts = await postHydrationService.hydratePosts(posts, {
          viewerId: userId,
          oxyClient: createScopedOxyClient(req),
          maxDepth: 1,
          includeLinkMetadata: true,
        });
        hydratedPosts.forEach((post) => postMap.set(post.id, post));
      } catch (e) {
        // Non-fatal; proceed without post embedding if query fails
      }
    }

    // Check if there are more results
    const hasMore = notificationsRaw.length > limit;
    const notificationsToReturn = hasMore ? notificationsRaw.slice(0, limit) : notificationsRaw;

    const notifications = notificationsToReturn.map((n: any) => {
      const actor = profilesMap.get(n.actorId);
      const entIdStr = String((n as any).entityId?._id || (n as any).entityId || '');
      const preview = (n.type === 'post' && n.entityType === 'post') ? postPreviewMap.get(entIdStr) : undefined;
      const embeddedPost = (n.type === 'post' && n.entityType === 'post') ? postMap.get(entIdStr) : undefined;
      return {
        ...n,
        preview,
        post: embeddedPost,
        actorId_populated: actor ? {
          ...toPopulatedActor(actor, n.actorId),
        } : undefined
      };
    });

    // Calculate next cursor from the last notification
    const nextCursor = hasMore && notificationsToReturn.length > 0
      ? String(notificationsToReturn[notificationsToReturn.length - 1]._id)
      : undefined;

    res.json({
      notifications,
      unreadCount,
      hasMore,
      nextCursor,
      limit
    });
  } catch (error) {
    logger.error("[Notifications] Error fetching notifications:", { userId: req.user?.id, error, cursor: req.query.cursor });
    res.status(500).json({ 
      message: "Error fetching notifications", 
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      notifications: [],
      unreadCount: 0,
      hasMore: false
    });
  }
});

// Create a notification (requires authentication)
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const notification = new Notification(req.body);
    await notification.save();
    await emitNotification(req, notification);
    // Enrich immediate response too
    let actor: any = null;
    try {
      if (notification.actorId && notification.actorId !== 'system') {
        actor = await oxy.getUserById(notification.actorId);
      }
    } catch (e) {
      logger.warn('[Notifications] Failed to resolve actor for new notification:', e);
    }
    const payload = {
      ...notification.toObject(),
      actorId_populated: actor ? {
        ...toPopulatedActor(actor, notification.actorId),
      } : undefined
    };
    res.status(201).json(payload);
  } catch (error) {
    res.status(500).json({ message: "Error creating notification" });
  }
});

// Mark notification as read
// Shared handler to mark notification as read
const markAsReadHandler = async (req: AuthRequest, res: Response) => {
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
    res.status(500).json({ message: "Error updating notification" });
  }
};

router.put("/:id/read", markAsReadHandler);
router.patch("/:id/read", markAsReadHandler);

// Mark all notifications as read
// Shared handler to mark all notifications as read
const markAllAsReadHandler = async (req: AuthRequest, res: Response) => {
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
    res.status(500).json({ message: "Error updating notifications" });
  }
};

router.put("/read-all", markAllAsReadHandler);
router.patch("/read-all", markAllAsReadHandler);

// Unread count endpoint
router.get('/unread-count', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const count = await Notification.countDocuments({ recipientId: userId, read: false });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching unread count' });
  }
});

// Archive a notification (soft action)
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // If we had an archived flag, we'd set it here. For now, mark as read.
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: userId },
      { read: true },
      { new: true }
    ).populate('actorId', 'username name avatar');

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationArchived', notification._id);

    res.json({ message: 'Notification archived', notification });
  } catch (error) {
    res.status(500).json({ message: 'Error archiving notification' });
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
  } catch (error) {
    res.status(500).json({ message: "Error deleting notification" });
  }
});
// --- Device Push Token Management ---
// Register or update a device push token
router.post('/push-token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const { token, platform, type, deviceId, locale } = req.body || {};
    if (!token) return res.status(400).json({ message: 'Token required' });
    const doc = await PushToken.findOneAndUpdate(
      { token },
      { userId, token, platform: platform || 'unknown', type: type || 'fcm', deviceId, locale, enabled: true, lastSeenAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true, id: doc._id });
  } catch (e) {
    logger.error('[Notifications] Failed to register push token:', { userId: req.user?.id, error: e });
    res.status(500).json({ message: 'Failed to register token' });
  }
});

// Unregister a device push token
router.delete('/push-token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ message: 'Token required' });
    await PushToken.deleteOne({ userId, token });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[Notifications] Failed to unregister push token:', { userId: req.user?.id, error: e });
    res.status(500).json({ message: 'Failed to unregister token' });
  }
});

// Send a test push to the authenticated user
router.post('/push-test', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    await sendPushToUser(userId, {
      title: 'Test notification',
      body: 'This is a test push from the server',
      data: { type: 'test' },
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[Notifications] Failed to send test push:', { userId: req.user?.id, error: e });
    res.status(500).json({ message: 'Failed to send test push' });
  }
});

export default router;
