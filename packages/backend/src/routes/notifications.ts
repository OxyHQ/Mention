import express, { Response } from "express";
import { type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, count, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { decodeChronoCursor, encodeChronoCursor } from '../utils/chronoCursor';
import {
  notifications,
  pushTokens,
  PUSH_TOKEN_PLATFORMS,
  PUSH_TOKEN_TYPES,
} from '../db/schema/discovery';
import { loadPostRecords } from '../db/posts/postRepository';
import { Server } from 'socket.io';
import { sendPushToUser } from '../utils/push';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import {
  createScopedOxyClient,
  createUserScopedOxyServices,
  getServiceOxyClient,
} from '../utils/oxyHelpers';
import { resolveNotificationInboxIds } from '../services/notificationInbox';
import { queryInt, queryString } from '../utils/queryParams';
import { apiRateLimiter } from '../middleware/rateLimiter';
import type { HydratedPost } from '@mention/shared-types';
import {
  toPopulatedActor,
  type NotificationActorProfile as ActorProfile,
} from '../utils/notificationActor';
import { serializeNotification } from '../utils/notificationUtils';
import {
  SYSTEM_ACTOR,
  enrichNotificationActor,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notificationReadState';
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

/**
 * The page order of `GET /notifications`, matching
 * `notifications_recipient_keyset_idx` key for key — including the NULLS
 * placement, without which the index cannot satisfy the sort. Exported so the
 * EXPLAIN test asserts the plan of the ORDER BY the route actually issues.
 */
export const NOTIFICATION_PAGE_ORDER: SQL[] = [
  sql`${notifications.createdAt} desc nulls last`,
  sql`${notifications.id} desc nulls last`,
];

/** Notification list page size (`GET /notifications`). */
const DEFAULT_NOTIFICATIONS_PAGE_SIZE = 20;
const MAX_NOTIFICATIONS_PAGE_SIZE = 50;
const POST_PREVIEW_TYPES = new Set(['like', 'reply', 'mention', 'boost', 'quote']);

// Rate-limit every notification endpoint (200 req/min, keyed by user with IP
// fallback). Covers the GET list/DB-access handlers flagged by CodeQL
// (js/missing-rate-limiting) plus unread-count, mark-read, and push-token.
router.use(apiRateLimiter);

/**
 * Narrow a raw request-body value to one of a column's allowed literals.
 *
 * `POST /push-token` is unvalidated and writes straight to the row, and the
 * Mongoose enums it used to hit ran NO validators on an upsert — an unrecognised
 * `platform` was stored VERBATIM. The CHECK constraints do not tolerate that, so
 * the two fallbacks are separated: an ABSENT field keeps the default the route
 * always applied (`platform || 'unknown'`, `type || 'fcm'`), while an
 * unrecognised value becomes `'unknown'`. Delivery is unchanged by either — the
 * push fan-out only ever sends to `type: 'fcm'`, so a token stored as
 * `'unknown'` receives exactly what a token stored as `'expo'` used to, whereas
 * folding it into `'fcm'` would start sending to a device that cannot take it.
 */
function allowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  whenAbsent: T,
  whenUnrecognised: T,
): T {
  if (typeof value !== 'string' || value === '') return whenAbsent;
  return (allowed as readonly string[]).includes(value) ? (value as T) : whenUnrecognised;
}

/** A body field that is only written when the client actually sent a string. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Every `recipientId` this request's viewer may read — themselves, plus any
 * CHANNEL they operate (a channel has no session of its own, so its inbox is
 * only reachable this way). See `services/notificationInbox`.
 *
 * EVERY recipient-scoped query in this file goes through here. A handler that
 * filters on `recipientId = userId` directly is not a smaller version of this —
 * it is a channel notification the operator can see in the list and then cannot
 * mark read, delete, or have counted in the badge.
 */
async function inboxRecipientIds(req: AuthRequest, userId: string): Promise<string[]> {
  return resolveNotificationInboxIds(userId, createUserScopedOxyServices(req));
}

/**
 * The recipient predicate for one viewer's inbox, over the ids
 * {@link inboxRecipientIds} resolved.
 *
 * `inArray` and not `eq`, at every site: the viewer's own id is only the first
 * entry. Narrowing any one query back to `eq(recipientId, userId)` does not
 * hide a channel row, it STRANDS it — the list still shows it and the write it
 * pairs with silently matches nothing.
 */
function recipientScope(recipientIds: string[]): SQL {
  return inArray(notifications.recipientId, recipientIds);
}

/**
 * The `:id` path param as a string.
 *
 * Express 5 types every param `string | string[]` (duplicate path segments), and
 * an id is now compared against a `text` column rather than cast by Mongoose.
 * Anything that is not a string becomes `''`, which names no row and therefore
 * answers 404 — never coerced into a plausible-looking id the way `String([x])`
 * would.
 */
function pathId(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

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

    const recipientIds = await inboxRecipientIds(req, userId);
    /** The channels among them — everything in the scope that is not the viewer. */
    const operatedChannelIds = new Set(recipientIds.filter((id) => id !== userId));

    const decodedCursor = cursor ? decodeChronoCursor(cursor) : undefined;
    if (cursor && !decodedCursor) {
      // NOT a query precondition — `INVALID_CURSOR` is a documented response the
      // client reads, and dropping it would be a fail-open change of the wire
      // contract: every column in the keyset is comparable against nonsense, so
      // a malformed token would silently serve an arbitrary page instead of the
      // 400 it used to. The codec accepts both live id shapes (`@oxyhq/db`), so
      // no cursor this server minted is ever refused.
      return res.status(400).json({
        message: "Invalid cursor format",
        error: "INVALID_CURSOR"
      });
    }

    const db = getDb();
    const recipientMatch = recipientScope(recipientIds);
    const pageWhere = decodedCursor
      ? and(
          recipientMatch,
          or(
            lt(notifications.createdAt, decodedCursor.createdAt),
            and(
              eq(notifications.createdAt, decodedCursor.createdAt),
              lt(notifications.id, decodedCursor.id),
            ),
          ),
        )
      : recipientMatch;

    // Fetch limit + 1 to determine if there are more results.
    //
    // The page order is `(created_at DESC, id DESC)` and the keyset compares the
    // PAIR, so the range and the sort agree and a boundary can neither repeat nor
    // skip a row. `created_at` has to lead: `id` is `text` holding a 24-char
    // ObjectId hex for pre-cutover rows and a uuid v7 for everything after, and
    // `'0' < '6'` under the database's collation — so ordering on `id` alone
    // (which this did) sorted every post-cutover notification BELOW every
    // pre-cutover one, and a migrated account's list opened on its oldest rows.
    // `id` stays as the tiebreak because `created_at` is not unique: it defaults
    // to `date_trunc('milliseconds', now())`, and `now()` is
    // `transaction_timestamp()`, so a fan-out written in one transaction shares
    // it exactly. Its collation order is irrelevant THERE — both sides of the
    // keyset use the same comparison.
    //
    // `nulls last` is NOT cosmetic and both columns being NOT NULL does not make
    // it redundant: drizzle emits `.desc()` in index DDL as `DESC NULLS LAST`,
    // while a plain `desc()` in a query means `DESC NULLS FIRST`, and Postgres
    // matches an index to an ORDER BY on the NULLS placement too. Measured on
    // 5,000 rows for one recipient — plain `desc()` plans a Bitmap Heap Scan
    // feeding a Sort of the whole match set (cost 459) before the LIMIT; spelled
    // `desc nulls last` it is an Index Only Scan with no Sort node at all (cost
    // 1.85). Asserted by an EXPLAIN test, because the wrong one returns exactly
    // the same rows and only shows up as a hot route sorting a user's entire
    // notification history on every page.
    //
    // The viewer's two safety gates are loaded alongside the page: a notification
    // carries OTHER people's post text (a reply, a mention), so the sensitive-content
    // opt-in and the muted words apply here exactly as they do to a feed. Both soft-fail
    // to their safe default and neither is worth a serial round trip.
    const [notificationsRaw, unreadRows, showSensitiveContent, muteWords] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(pageWhere)
        .orderBy(...NOTIFICATION_PAGE_ORDER)
        .limit(limit + 1),
      db
        .select({ value: count() })
        .from(notifications)
        .where(and(recipientMatch, eq(notifications.read, false))),
      loadShowSensitiveContent(userId),
      loadMuteWords(userId),
    ]);

    const unreadCount = unreadRows[0]?.value ?? 0;

  // Resolve unique actor profiles from Oxy to enrich response
    const uniqueActorIds = Array.from(new Set(
      notificationsRaw.map((n) => n.actorId).filter(Boolean)
    ));

    // Channels named as the RECIPIENT of a row on this page. A notification the
    // viewer received because they operate a channel says "liked your post" about
    // a post the viewer very likely did not write, so the row has to name whose
    // inbox it arrived in or it is simply wrong on its face. Resolving the
    // channel's public profile costs nothing extra — it joins the actor batch
    // below, and a channel is usually also the actor's target anyway.
    const channelRecipientIds = Array.from(new Set(
      notificationsRaw.map((n) => n.recipientId).filter((id) => Boolean(id) && id !== userId),
    ));

    const profilesMap = new Map<string, ActorProfile>();
    if (uniqueActorIds.includes('system')) {
      profilesMap.set('system', SYSTEM_ACTOR);
    }
    // Single bulk fetch for all real actors (chunked/deduped by the SDK) instead
    // of one getUserById HTTP request per actor.
    const profileIdsToResolve = Array.from(new Set(
      [...uniqueActorIds, ...channelRecipientIds].filter((id) => id !== 'system'),
    ));
    if (profileIdsToResolve.length > 0) {
      try {
        const profiles = await getServiceOxyClient().getUsersByIds(profileIdsToResolve);
        for (const profile of profiles) {
          if (profile?.id) profilesMap.set(profile.id, profile);
        }
      } catch (e) {
        logger.warn('[Notifications] Failed to bulk-resolve actor profiles:', e);
      }
    }

    // Resolve every post referenced by a notification through the SAME
    // viewer-aware hydration/ACL path used by feeds and post detail. Never build
    // a preview from the raw Mongo row: that would reveal content from a newly
    // blocked/restricted author, private profile, followers-only post, draft, or
    // other row that hydration correctly removes for this viewer.
    const referencedPostIds = Array.from(new Set(
      notificationsRaw
        .filter((n) => n.entityId && (
          (n.type === 'post' && n.entityType === 'post') ||
          (POST_PREVIEW_TYPES.has(n.type) && (n.entityType === 'post' || n.entityType === 'reply'))
        ))
        .map((n) => n.entityId),
    ));

    const postPreviewMap = new Map<string, string>();
    const postMap = new Map<string, HydratedPost>();
    /** Referenced posts the viewer muted — their notifications are dropped below. */
    const mutedPostIds = new Set<string>();
    if (referencedPostIds.length > 0) {
      // Whole records: `hydratePosts` reads `boostOf`/`quoteOf` (nested embeds),
      // `parentPostId`/`threadId`/`type` (thread + type flags) and
      // `visibility`/`status` (publication controls), and `requiresContentWarning`
      // below reads every sensitivity signal the row carries.
      const posts = await loadPostRecords(referencedPostIds.map(String));

      // Sensitivity is read off the RAW rows, which carry every signal (the classifier
      // verdict, the legacy flag, the federated flag/CW, the hashtags) — the hydrated
      // DTO deliberately exposes only a subset.
      const gatedPostIds = new Set(
        posts.filter((post) => requiresContentWarning(post)).map((post) => post.id),
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
        //
        // A post authored by a channel the viewer OPERATES is their own work by the
        // same argument — `viewerState.isOwner` cannot see it, because the owner of
        // that post is the channel account and the viewer is a person. Without this
        // an operator's own muted word silently deletes their channel's engagement,
        // which is the exact failure the paragraph above exists to prevent.
        const isOwnPost =
          post.viewerState?.isOwner === true ||
          post.viewerState?.isCollaborator === true ||
          (post.user?.id !== undefined && operatedChannelIds.has(post.user.id));

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
    const notificationList = notificationsToReturn
      .filter((n) => !mutedPostIds.has(n.entityId))
      .map((n) => {
        const actor = profilesMap.get(n.actorId);
        // `preview` now covers post + like/reply/mention/boost/quote (any type
        // whose entityId resolved a cheap text preview above). The full hydrated
        // `post` embed stays gated to `type:'post'`.
        const preview = postPreviewMap.get(n.entityId);
        const embeddedPost = (n.type === 'post' && n.entityType === 'post') ? postMap.get(n.entityId) : undefined;
        return {
          ...serializeNotification(n),
          preview,
          post: embeddedPost,
          actorId_populated: toPopulatedActor(actor, n.actorId),
          // Present ONLY when the row was addressed somewhere other than the
          // viewer — i.e. to a channel they operate. Its absence is what the
          // client reads as "this one is mine", so it must never be populated
          // for the viewer's own rows. It carries the channel's PUBLIC profile
          // and nothing else: who WROTE the post behind it stays server-side
          // (`UserSettings.channel.signPosts` is the only thing that discloses a
          // writer, and it does so on the post, not here).
          recipientId_populated:
            n.recipientId === userId
              ? undefined
              : toPopulatedActor(profilesMap.get(n.recipientId), n.recipientId),
        };
      });

    // The next cursor is the last row of the UNFILTERED page window, encoded on
    // the same `(created_at, id)` pair the order and the keyset use.
    const anchor = hasMore ? notificationsToReturn[notificationsToReturn.length - 1] : undefined;
    const nextCursor = anchor ? encodeChronoCursor(anchor.createdAt, anchor.id) : undefined;

    res.json({
      notifications: notificationList,
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

    const enriched = await markNotificationRead(
      await inboxRecipientIds(req, userId),
      pathId(req.params.id),
    );

    if (!enriched) {
      return res.status(404).json({ message: "Notification not found" });
    }

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

    await markAllNotificationsRead(await inboxRecipientIds(req, userId));

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
    const [row] = await getDb()
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          recipientScope(await inboxRecipientIds(req, userId)),
          eq(notifications.read, false),
        ),
      );
    res.json({ count: row?.value ?? 0 });
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
    const [notification] = await getDb()
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.id, pathId(req.params.id)),
          recipientScope(await inboxRecipientIds(req, userId)),
        ),
      )
      .returning();

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    const enriched = await enrichNotificationActor(notification);

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationArchived', notification.id);

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

    const [notification] = await getDb()
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, pathId(req.params.id)),
          recipientScope(await inboxRecipientIds(req, userId)),
        ),
      )
      .returning({ id: notifications.id });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const io = req.app.get('notificationsNamespace') as Server;
    io.to(`user:${userId}`).emit('notificationDeleted', notification.id);

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
    if (typeof token !== 'string' || !token) return res.status(400).json({ message: 'Token required' });

    // `push_tokens.token` is GLOBALLY unique — one device, one row, owned by
    // whichever account registered it last. The conflict target is therefore the
    // token alone, and `userId` is part of the SET: re-registering a handset on a
    // second account must transfer the row, not fail. `deviceId`/`locale` are
    // only written when the client sent them, because Mongoose dropped undefined
    // paths from an update and a re-registration must not blank what it omitted.
    const deviceIdValue = optionalText(deviceId);
    const localeValue = optionalText(locale);
    const registration = {
      userId,
      platform: allowedValue(platform, PUSH_TOKEN_PLATFORMS, 'unknown', 'unknown'),
      type: allowedValue(type, PUSH_TOKEN_TYPES, 'fcm', 'unknown'),
      enabled: true,
      lastSeenAt: new Date(),
      ...(deviceIdValue === undefined ? {} : { deviceId: deviceIdValue }),
      ...(localeValue === undefined ? {} : { locale: localeValue }),
    };

    const [row] = await getDb()
      .insert(pushTokens)
      .values({ token, ...registration })
      .onConflictDoUpdate({
        target: pushTokens.token,
        // `updated_at` is explicit here: drizzle's `$onUpdate` fires for
        // `db.update()`, never for an `ON CONFLICT ... DO UPDATE` set clause, so
        // omitting it would freeze the column at the row's creation time.
        set: { ...registration, updatedAt: new Date() },
      })
      .returning({ id: pushTokens.id });

    res.json({ ok: true, id: row.id });
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
    if (typeof token !== 'string' || !token) return res.status(400).json({ message: 'Token required' });
    await getDb()
      .delete(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
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
