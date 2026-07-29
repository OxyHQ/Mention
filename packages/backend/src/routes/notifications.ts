import express, { Response } from "express";
import { type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import mongoose from 'mongoose';
import Notification, { INotification } from "../models/Notification";
import Post from "../models/Post";
import { Server } from 'socket.io';
import PushToken from '../models/PushToken';
import { sendPushToUser } from '../utils/push';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import { queryInt, queryString } from '../utils/queryParams';
import { apiRateLimiter } from '../middleware/rateLimiter';
import type { HydratedPost } from '@mention/shared-types';
import {
  toPopulatedActor,
  type NotificationActorProfile as ActorProfile,
} from '../utils/notificationActor';
import { requiresContentWarning } from '../mtn/feed/feedSafety';
import { loadMuteWords, loadShowSensitiveContent } from '../services/safety/viewerSafety';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
} from '../services/safety/muteWordMatcher';
import { loadFollowedAuthorIds } from '../services/viewerFollowGraph';

export { toPopulatedActor };

const router = express.Router();

/** Notification list page size (`GET /notifications`). */
const DEFAULT_NOTIFICATIONS_PAGE_SIZE = 20;
const MAX_NOTIFICATIONS_PAGE_SIZE = 50;
const POST_PREVIEW_TYPES = new Set(['like', 'reply', 'mention', 'boost', 'quote']);

// Rate-limit every notification endpoint (200 req/min, keyed by user with IP
// fallback). Covers the GET list/DB-access handlers flagged by CodeQL
// (js/missing-rate-limiting) plus unread-count, mark-read, and push-token.
router.use(apiRateLimiter);

/**
 * Minimal read-surface of an actor profile consumed by `toPopulatedActor`.
 * `getUsersByIds`/`getUserById` return full `User` objects (assignable to this),
 * while the synthetic `system` actor only needs these fields.
 */
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
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_NOTIFICATIONS_PAGE_SIZE, 1), MAX_NOTIFICATIONS_PAGE_SIZE);

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
    // The viewer's two safety gates are loaded alongside the page: a notification
    // carries OTHER people's post text (a reply, a mention), so the sensitive-content
    // opt-in and the muted words apply here exactly as they do to a feed. Both soft-fail
    // to their safe default and neither is worth a serial round trip.
    const [notificationsRaw, unreadCount, showSensitiveContent, muteWords] = await Promise.all([
      Notification.find(query)
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean<LeanNotification[]>(),
      Notification.countDocuments({
        recipientId: userId,
        read: false
      }),
      loadShowSensitiveContent(userId),
      loadMuteWords(userId),
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
        const profiles = await getServiceOxyClient().getUsersByIds(realActorIds);
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

    // Resolve every post referenced by a notification through the SAME
    // viewer-aware hydration/ACL path used by feeds and post detail. Never build
    // a preview from the raw Mongo row: that would reveal content from a newly
    // blocked/restricted author, private profile, followers-only post, draft, or
    // other row that hydration correctly removes for this viewer.
    const referencedPostIds = Array.from(new Set(
      notificationsRaw
        .filter((n) => n && n.entityId && (
          (n.type === 'post' && n.entityType === 'post') ||
          (POST_PREVIEW_TYPES.has(n.type) && (n.entityType === 'post' || n.entityType === 'reply'))
        ))
        .map((n) => resolveEntityId(n.entityId))
        .filter(Boolean),
    ));

    const postPreviewMap = new Map<string, string>();
    const postMap = new Map<string, HydratedPost>();
    /** Referenced posts the viewer muted — their notifications are dropped below. */
    const mutedPostIds = new Set<string>();
    if (referencedPostIds.length > 0) {
      // Fetch full lean docs (no field projection): `hydratePosts` reads
      // `boostOf`/`quoteOf` (nested embeds), `parentPostId`/`threadId`/`type`
      // (thread + type flags) and `visibility`/`status` (publication controls).
      const posts = await Post.find({ _id: { $in: referencedPostIds } }).lean();

      // Sensitivity is read off the RAW rows, which carry every signal (the classifier
      // verdict, the legacy flag, the federated flag/CW, the hashtags) — the hydrated
      // DTO deliberately exposes only a subset.
      const gatedPostIds = new Set(
        posts.filter((post) => requiresContentWarning(post)).map((post) => String(post._id)),
      );

      const scopedOxyClient = createScopedOxyClient(req);

      // Deliberately let hydration/privacy failures reach the outer handler.
      // Returning a partially enriched page would otherwise make a transient
      // privacy-authority outage indistinguishable from authorization success.
      const hydratedPosts = await postHydrationService.hydratePosts(posts, {
        viewerId: userId,
        oxyClient: scopedOxyClient,
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      const compiledMuteWords = compileMuteWords(muteWords);
      const followedAuthorIds = compiledMuteWords?.needsFollowState
        ? await loadFollowedAuthorIds(userId, scopedOxyClient)
        : NO_FOLLOWED_AUTHORS;

      for (const post of hydratedPosts) {
        // BOTH gates protect the viewer from OTHER people's content, so neither applies
        // to a post the viewer wrote: a sensitive post is no surprise to its own author,
        // and hiding "someone liked your post" because the post uses a word THEY muted
        // would silently drop real engagement on their own work.
        const isOwnPost = post.viewerState?.isOwner === true || post.viewerState?.isCollaborator === true;

        if (!isOwnPost && compiledMuteWords && isMutedSubject(
          compiledMuteWords,
          { text: post.content.text, hashtags: post.metadata?.hashtags, authorId: post.user?.id },
          followedAuthorIds,
        )) {
          // A muted word means "do not put this in front of me". Blanking the text but
          // keeping the row would still announce the interaction and invite a tap
          // through to the very content they muted, so the notification goes entirely.
          mutedPostIds.add(post.id);
          continue;
        }

        // A notification preview is plain text and the embed is rendered without the
        // in-app spoiler chrome, so neither can carry content that is only safe behind
        // a warning. The notification itself is kept — the viewer still learns someone
        // replied, and the post opens in the app where the warning does apply.
        if (!isOwnPost && !showSensitiveContent && gatedPostIds.has(post.id)) {
          continue;
        }

        postMap.set(post.id, post);
        const text = post.content.text?.trim() ?? '';
        postPreviewMap.set(
          post.id,
          text.length > 200 ? `${text.slice(0, 200)}…` : text,
        );
      }
    }

    // Check if there are more results
    const hasMore = notificationsRaw.length > limit;
    const notificationsToReturn = hasMore ? notificationsRaw.slice(0, limit) : notificationsRaw;

    // Muted notifications are dropped AFTER `hasMore`/`nextCursor` were taken from the
    // unfiltered page window, so a page can come back short but never skips a
    // notification on the next one. `unreadCount` is a separate global aggregate and
    // still counts a dropped notification — muting is evaluated at read time, against
    // the rules as they stand now, rather than stamped onto the row when it was written.
    const notifications = notificationsToReturn
      .filter((n) => !mutedPostIds.has(resolveEntityId(n.entityId)))
      .map((n) => {
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
          actorId_populated: toPopulatedActor(actor, n.actorId),
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

/**
 * Enrich a single notification with its actor profile the SAME way the GET list
 * handler does. `actorId` holds an Oxy user id (`type: String`), NOT a Mongoose
 * ref, so `.populate('actorId')` is a silent no-op — the actor must be resolved
 * through Oxy instead. Returns a plain object with `actorId_populated` attached
 * (matching the GET list DTO); on a lookup failure the notification is returned
 * unenriched so the read-state write is never blocked.
 */
const enrichNotificationActor = async (notification: INotification) => {
  const actorId = notification.actorId;
  let actor: ActorProfile | undefined;
  if (actorId === 'system') {
    actor = SYSTEM_ACTOR;
  } else if (actorId) {
    try {
      const [profile] = await getServiceOxyClient().getUsersByIds([actorId]);
      if (profile?.id) actor = profile;
    } catch (e) {
      logger.warn('[Notifications] Failed to resolve actor profile:', e);
    }
  }
  return {
    ...notification.toObject(),
    actorId_populated: toPopulatedActor(actor, actorId),
  };
};

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
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const enriched = await enrichNotificationActor(notification);

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationUpdated', enriched);

    res.json({ message: "Notification marked as read", notification: enriched });
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
    );

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    const enriched = await enrichNotificationActor(notification);

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationArchived', notification._id);

    res.json({ message: 'Notification archived', notification: enriched });
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
