import express, { Request, Response } from "express";
import Notification from "../models/Notification";
import Post from "../models/Post";
import { Server } from 'socket.io';
import { oxy } from '../../server';
import PushToken from '../models/PushToken';
import { sendPushToUser } from '../utils/push';

// Extend Request type to include user property
interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

const router = express.Router();

// Helper function to emit notification event
const emitNotification = async (req: Request, notification: any) => {
  const io = req.app.get('io') as Server;
  const notificationsNamespace = io.of('/notifications');
  let actor: any = null;
  try {
    if (notification.actorId && notification.actorId !== 'system') {
      actor = await oxy.getUserById(notification.actorId);
    } else if (notification.actorId === 'system') {
      actor = { id: 'system', username: 'system', name: { full: 'System' }, avatar: undefined };
    }
  } catch (e) {
    // ignore resolution errors
  }
  // Attach preview and embedded post for post notifications if applicable
  let preview: string | undefined;
  let embeddedPost: any | undefined;
  try {
    if (notification.type === 'post' && notification.entityType === 'post' && notification.entityId) {
      const post: any = await Post.findById(notification.entityId, {
        _id: 1,
        oxyUserId: 1,
        content: 1,
        stats: 1,
        metadata: 1,
        createdAt: 1
      }).lean();
      if (post) {
        const text: string = post?.content?.text || '';
        const trimmed = typeof text === 'string' ? text.trim() : '';
        preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
        try {
          const profile = await oxy.getUserById(post.oxyUserId);
          embeddedPost = {
            id: String(post._id),
            user: {
              id: profile?.id || post.oxyUserId,
              name: profile?.name?.full || profile?.name || profile?.username || 'User',
              handle: profile?.username || 'user',
              avatar: profile?.avatar || '',
              verified: !!profile?.verified,
            },
            content: post.content || { text: '' },
            date: post.createdAt,
            engagement: {
              replies: post?.stats?.commentsCount || 0,
              reposts: post?.stats?.repostsCount || 0,
              likes: post?.stats?.likesCount || 0,
            },
            isLiked: false,
            isReposted: false,
            isSaved: false,
            isThread: false,
          };
        } catch {}
      }
    }
  } catch {}
  const payload = {
    ...notification.toObject?.() || notification,
    preview,
    post: embeddedPost,
    actorId_populated: actor ? {
      _id: actor.id || actor._id || notification.actorId,
      username: actor.username || notification.actorId,
      name: actor.name?.full || actor.name || actor.username || notification.actorId,
      avatar: actor.avatar
    } : undefined
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

  const [notificationsRaw, unreadCount] = await Promise.all([
      Notification.find({ recipientId: userId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('entityId')
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
          profilesMap.set(id, { id: 'system', username: 'system', name: { full: 'System' }, avatar: undefined });
        } else {
          const profile = await oxy.getUserById(id);
          profilesMap.set(id, profile);
        }
      } catch (e) {
        // If lookup fails, leave it absent; client can fall back
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

        // Resolve unique author profiles for posts
        const authorIds = Array.from(new Set(posts.map((p: any) => p.oxyUserId).filter(Boolean)));
        const authorMap = new Map<string, any>();
        await Promise.all(authorIds.map(async (id: string) => {
          try {
            const profile = await oxy.getUserById(id);
            authorMap.set(id, profile);
          } catch {}
        }));

        // Transform to UI post objects
        posts.forEach((p: any) => {
          const profile = authorMap.get(p.oxyUserId) || {};
          const uiPost = {
            id: String(p._id),
            user: {
              id: profile.id || p.oxyUserId,
              name: profile?.name?.full || profile?.name || profile?.username || 'User',
              handle: profile?.username || 'user',
              avatar: profile?.avatar || '',
              verified: !!profile?.verified,
            },
            content: p.content || { text: '' },
            date: p.createdAt,
            engagement: {
              replies: p?.stats?.commentsCount || 0,
              reposts: p?.stats?.repostsCount || 0,
              likes: p?.stats?.likesCount || 0,
            },
            isLiked: false,
            isReposted: false,
            isSaved: false,
            isThread: false,
          };
          postMap.set(String(p._id), uiPost);
        });
      } catch (e) {
        // Non-fatal; proceed without post embedding if query fails
      }
    }

    const notifications = notificationsRaw.map((n: any) => {
      const actor = profilesMap.get(n.actorId);
      const entIdStr = String((n as any).entityId?._id || (n as any).entityId || '');
      const preview = (n.type === 'post' && n.entityType === 'post') ? postPreviewMap.get(entIdStr) : undefined;
      const embeddedPost = (n.type === 'post' && n.entityType === 'post') ? postMap.get(entIdStr) : undefined;
      return {
        ...n,
        preview,
        post: embeddedPost,
        actorId_populated: actor ? {
          _id: actor.id || actor._id || n.actorId,
          username: actor.username || n.actorId,
          name: actor.name?.full || actor.name || actor.username || n.actorId,
          avatar: actor.avatar
        } : undefined
      };
    });

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
    // Enrich immediate response too
    let actor: any = null;
    try {
      if (notification.actorId && notification.actorId !== 'system') {
        actor = await oxy.getUserById(notification.actorId);
      }
    } catch {}
    const payload = {
      ...notification.toObject(),
      actorId_populated: actor ? {
        _id: actor.id || actor._id || notification.actorId,
        username: actor.username || notification.actorId,
        name: actor.name?.full || actor.name || actor.username || notification.actorId,
        avatar: actor.avatar
      } : undefined
    };
    res.status(201).json(payload);
  } catch (error) {
    res.status(500).json({ message: "Error creating notification", error });
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
    res.status(500).json({ message: "Error updating notification", error });
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
    res.status(500).json({ message: "Error updating notifications", error });
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
    res.status(500).json({ message: 'Error fetching unread count', error });
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
    res.status(500).json({ message: 'Error archiving notification', error });
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
    console.error('Failed to register push token', e);
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
    console.error('Failed to unregister push token', e);
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
    console.error('Failed to send test push', e);
    res.status(500).json({ message: 'Failed to send test push' });
  }
});

export default router;