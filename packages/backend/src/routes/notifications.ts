import express, { Response } from "express";
import { type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import mongoose from 'mongoose';
import Notification, { INotification } from "../models/Notification";
import Post from "../models/Post";
import { Server } from 'socket.io';
import { oxy } from '../../server';
import PushToken from '../models/PushToken';
import { sendPushToUser } from '../utils/push';
import { resolveAvatarUrl } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { apiRateLimiter } from '../middleware/rateLimiter';
import type { HydratedPost } from '@mention/shared-types';
import type { User } from '@oxyhq/core';

const router = express.Router();

// Rate-limit every notification endpoint (200 req/min, keyed by user with IP
// fallback). Covers the GET list/DB-access handlers flagged by CodeQL
// (js/missing-rate-limiting) plus unread-count, mark-read, and push-token.
router.use(apiRateLimiter);

/**
 * Minimal read-surface of an actor profile consumed by `toPopulatedActor`.
 * `getUsersByIds`/`getUserById` return full `User` objects (assignable to this),
 * while the synthetic `system` actor only needs these fields.
 */
type ActorProfile = Pick<User, 'username' | 'name' | 'avatar'> & {
  id?: string;
  _id?: string;
};

export function toPopulatedActor(actor: ActorProfile, fallbackId: unknown) {
  const id = String(actor?.id || actor?._id || fallbackId);
  // Emit the canonical, required `name.displayName` (profile-identity contract).
  // For a resolved Oxy user this is always present and composed server-side; the
  // `|| id` floor is the never-blank last resort (the handle), NOT a name
  // recompute. Clients render `name.displayName` directly.
  const displayName = (actor?.name?.displayName && actor.name.displayName.trim()) || id;
  return {
    _id: id,
    username: actor?.username || id,
    name: { displayName },
    avatar: resolveAvatarUrl(typeof actor?.avatar === 'string' ? actor.avatar : undefined),
  };
}

const SYSTEM_ACTOR: ActorProfile = {
  id: 'system',
  username: 'system',
  name: { displayName: 'System' },
  avatar: undefined,
};

/**
 * Lean shape of a Notification as read in the GET handler. `entityId` is the raw
 * reference id (never populated — the post rows are batch-fetched by `$in`
 * below); `string` covers legacy/defensive reads.
 */
type LeanNotification = Omit<INotification, keyof mongoose.Document | 'entityId'> & {
  _id: mongoose.Types.ObjectId;
  entityId: mongoose.Types.ObjectId | string | null;
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
    const query: { recipientId: string; _id?: { $lt: mongoose.Types.ObjectId } } = { recipientId: userId };
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

    // Fetch limit + 1 to determine if there are more results.
    // Sort by `_id` descending to match the `_id < cursor` keyset filter (both
    // the range and the sort are on `_id`), so the query is fully served by the
    // `{ recipientId: 1, _id: -1 }` index and pagination is consistent. `_id`
    // descending is chronological newest-first (ObjectIds embed a timestamp).
    const [notificationsRaw, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean<LeanNotification[]>(),
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
      notificationsRaw.map((n) => n.actorId).filter(Boolean)
    ));

    const profilesMap = new Map<string, ActorProfile>();
    if (uniqueActorIds.includes('system')) {
      profilesMap.set('system', SYSTEM_ACTOR);
    }
    // Single bulk fetch for all real actors (chunked/deduped by the SDK) instead
    // of one getUserById HTTP request per actor.
    const realActorIds = uniqueActorIds.filter((id) => id !== 'system');
    if (realActorIds.length > 0) {
      try {
        const profiles = await oxy.getUsersByIds(realActorIds);
        for (const profile of profiles) {
          if (profile?.id) profilesMap.set(profile.id, profile);
        }
      } catch (e) {
        logger.warn('[Notifications] Failed to bulk-resolve actor profiles:', e);
      }
    }

    // `entityId` is a raw ObjectId (or a legacy string); resolve it to its id.
    const resolveEntityId = (ent: LeanNotification['entityId']): string =>
      ent ? String(ent) : '';

    // For 'post' notifications, fetch post docs to provide a short preview and full post data
    const postEntityIds = notificationsRaw
      .filter((n) => n && n.type === 'post' && n.entityType === 'post' && n.entityId)
      .map((n) => resolveEntityId(n.entityId))
      .filter(Boolean);

    const postPreviewMap = new Map<string, string>();
    const postMap = new Map<string, HydratedPost>();
    if (postEntityIds.length > 0) {
      try {
        // Fetch full lean docs (no field projection): `hydratePosts` reads
        // `boostOf`/`quoteOf` (nested embeds), `parentPostId`/`threadId`/`type`
        // (thread + type flags) and `visibility`/`status` (publication controls).
        // A narrow projection silently drops these, rendering quote/boost cards
        // blank and mis-flagging replies. This mirrors the single-notification
        // realtime path above and every other `hydratePosts` call site.
        const posts = await Post.find({ _id: { $in: postEntityIds } }).lean();

        // Build preview map
        for (const p of posts) {
          const text: string = p?.content?.text || '';
          const trimmed = typeof text === 'string' ? text.trim() : '';
          const truncated = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
          postPreviewMap.set(String(p._id), truncated);
        }

        const hydratedPosts = await postHydrationService.hydratePosts(posts, {
          viewerId: userId,
          oxyClient: createScopedOxyClient(req),
          maxDepth: 1,
          includeLinkMetadata: true,
        });
        hydratedPosts.forEach((post) => postMap.set(post.id, post));
      } catch (e) {
        // Non-fatal; proceed without post embedding if query fails
        logger.warn('[Notifications] Failed to embed posts for notifications:', e);
      }
    }

    // For reaction/reply notifications, attach a CHEAP text preview so the feed
    // rows can show which post was acted upon. Projected read of `content.text`
    // ONLY — no `PostHydrationService`, no boost/quote/thread embeds — so this
    // stays O(1) per notification. Reuses the same `postPreviewMap`.
    const PREVIEW_TYPES = new Set(['like', 'reply', 'mention', 'boost', 'quote']);
    const previewEntityIds = notificationsRaw
      .filter((n) => n && PREVIEW_TYPES.has(n.type)
        && (n.entityType === 'post' || n.entityType === 'reply') && n.entityId)
      .map((n) => resolveEntityId(n.entityId))
      .filter(Boolean);

    if (previewEntityIds.length > 0) {
      try {
        const previewDocs = await Post.find(
          { _id: { $in: previewEntityIds } },
          { 'content.text': 1 },
        ).lean();
        for (const p of previewDocs) {
          const text = typeof p?.content?.text === 'string' ? p.content.text.trim() : '';
          postPreviewMap.set(String(p._id), text.length > 200 ? `${text.slice(0, 200)}…` : text);
        }
      } catch (e) {
        // Non-fatal; proceed without previews if the projected query fails.
        logger.warn('[Notifications] Failed to build reaction previews:', e);
      }
    }

    // Check if there are more results
    const hasMore = notificationsRaw.length > limit;
    const notificationsToReturn = hasMore ? notificationsRaw.slice(0, limit) : notificationsRaw;

    const notifications = notificationsToReturn.map((n) => {
      const actor = profilesMap.get(n.actorId);
      const entIdStr = resolveEntityId(n.entityId);
      // `preview` now covers post + like/reply/mention/boost/quote (any type
      // whose entityId resolved a cheap text preview above). The full hydrated
      // `post` embed stays gated to `type:'post'`.
      const preview = postPreviewMap.get(entIdStr);
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

// Notifications are SERVER-AUTHORED ONLY. There is intentionally no
// client-callable creation route: legitimate notifications are created as
// side effects of verified actions via the `createNotification` service
// (`utils/notificationUtils.ts`), never from a client-supplied payload. A
// public POST here would let any authenticated user forge a persisted +
// realtime notification to any recipient with an attacker-chosen
// type/entityId (a phishing/harassment vector).

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
