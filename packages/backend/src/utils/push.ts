// firebase-admin 14 removed the `admin.*` namespace (`admin.credential`,
// `admin.messaging()`); the modular subpath entries below are the whole API now.
import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeInlineText } from '@oxy.so/core';
import { getFirebaseConfig } from '../config';
import { getDb } from '../db/postgres';
import { pushTokens, type NOTIFICATION_TYPES } from '../db/schema/discovery';
import { userSettings } from '../db/schema/userProfile';
import { resolveVariant } from '../services/postVariants';
import { loadPostRecord } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { getServiceOxyClient } from './oxyHelpers';
import { logger } from './logger';
import { chunk } from '@oxy.so/utils/text';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const firebase = getFirebaseConfig();
  if (!firebase) {
    logger.warn(
      '[Push] Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID',
    );
    return;
  }
  try {
    const json = Buffer.from(firebase.serviceAccountBase64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(json) as ServiceAccount;
    initializeApp({
      credential: cert(serviceAccount),
      projectId: firebase.projectId,
    });
    firebaseInitialized = true;
    logger.info('[Push] Firebase Admin initialized for FCM');
  } catch (e) {
    logger.error('[Push] Failed to initialize Firebase Admin:', e);
  }
}

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

/**
 * Build the concise single-line preview of a post body for a push notification.
 *
 * The whitespace collapse is the canonical `normalizeInlineText` — a push body is
 * a ONE-LINE label, and the post text feeding it can be a federated body carrying
 * the remote markup's newlines and indentation. Truncation and the ellipsis are
 * NOT part of normalization: they are this surface's own product rule (a push
 * body has a length budget), so they stay here.
 */
export function buildPreview(text: string, limit: number = 200): string {
  const preview = normalizeInlineText(text || '');
  if (!preview) return '';
  return preview.length > limit ? `${preview.slice(0, limit)}…` : preview;
}

/** True when FCM is configured and initialized — nothing below does any work otherwise. */
export function isPushAvailable(): boolean {
  initFirebase();
  return firebaseInitialized;
}

/**
 * Send one payload to a set of FCM tokens, disabling the ones FCM rejects as
 * dead. The caller has already chosen the tokens — see {@link loadPushTargets}
 * for a notification and {@link sendPushToUser} for an unconditional push.
 */
export async function sendPushToTokens(fcmTokens: readonly string[], payload: PushPayload) {
  if (!fcmTokens.length || !isPushAvailable()) return;
  try {
    const tokenChunks = chunk([...fcmTokens], 500); // FCM limit per multicast
    const toDisable: string[] = [];
    for (const tkChunk of tokenChunks) {
      const message: MulticastMessage = {
        tokens: tkChunk,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data || {},
        android: {
          priority: 'high',
          notification: { channelId: 'default' },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
        },
      };
      const resp = await getMessaging().sendEachForMulticast(message);
      // Cleanup invalid tokens in this chunk
      if (resp.responses) {
        resp.responses.forEach((r, idx) => {
          if (!r.success) {
            const errorInfo =
              r.error && 'errorInfo' in r.error
                ? (r.error as { errorInfo?: { code?: string } }).errorInfo
                : undefined;
            const code = errorInfo?.code || r.error?.code;
            if (
              code &&
              (code.includes('registration-token-not-registered') ||
                code.includes('invalid-argument'))
            ) {
              const bad = tkChunk[idx];
              if (bad) toDisable.push(bad);
            }
          }
        });
      }
    }
    if (toDisable.length) {
      // `inArray`, never `= any(${toDisable})`: a raw JS array interpolated into
      // `sql` binds as a ROW constructor, which Postgres rejects at runtime only.
      await getDb()
        .update(pushTokens)
        .set({ enabled: false })
        .where(inArray(pushTokens.token, toDisable));
      logger.info(`[Push] Disabled invalid push tokens: ${toDisable.length}`);
    }
  } catch (e) {
    logger.error('[Push] Failed to send push:', e);
  }
}

/**
 * Push to every enabled FCM device of one user, regardless of their notification
 * settings — the `/push-test` route, where the user asked for exactly this push.
 * A notification goes through {@link loadPushTargets} instead.
 */
export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!isPushAvailable()) return;
  try {
    // Served by `push_tokens_user_enabled_idx`, the partial index on enabled
    // rows. The `type` filter stays in memory exactly as before: a device is
    // one row, so the set is tiny and no index would earn its keep.
    const tokens = await getDb()
      .select({ token: pushTokens.token, type: pushTokens.type })
      .from(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.enabled, true)));
    await sendPushToTokens(
      tokens.filter((t) => t.type === 'fcm').map((t) => t.token),
      payload,
    );
  } catch (e) {
    logger.error('[Push] Failed to send push:', e);
  }
}

type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * The Settings → Notifications toggle that governs each type's PUSH. A type
 * absent here (poke, post, welcome, collab_*) has no toggle of its own and
 * answers only to the master `notifyPushEnabled` switch.
 */
const PUSH_PREFERENCE_COLUMN = {
  like: userSettings.notifyLikes,
  reply: userSettings.notifyReplies,
  boost: userSettings.notifyBoosts,
  mention: userSettings.notifyMentions,
  quote: userSettings.notifyQuotes,
  follow: userSettings.notifyFollows,
} as const satisfies Partial<Record<NotificationType, unknown>>;

/**
 * For every recipient a push of `type` may go to: their enabled FCM tokens.
 * Recipients with no device, or whose settings turned this push off, are absent.
 *
 * ONE query for the whole fan-out: the devices and the settings row are read
 * together (a LEFT JOIN, so a user with no settings row gets the schema defaults
 * — every toggle on), rather than a settings SELECT and a token SELECT per
 * recipient. Devices are read FIRST by construction: most recipients have none
 * registered, and they cost nothing further — no settings read, no payload.
 *
 * The toggles govern the push only; the notification row and the socket event
 * are written regardless, so turning "Replies" off silences the phone without
 * the inbox losing anything.
 */
export async function loadPushTargets(
  userIds: readonly string[],
  type: NotificationType,
): Promise<Map<string, string[]>> {
  const targets = new Map<string, string[]>();
  if (userIds.length === 0 || !isPushAvailable()) return targets;

  const typeColumn =
    type in PUSH_PREFERENCE_COLUMN
      ? PUSH_PREFERENCE_COLUMN[type as keyof typeof PUSH_PREFERENCE_COLUMN]
      : null;
  const rows = await getDb()
    .select({
      userId: pushTokens.userId,
      token: pushTokens.token,
      type: pushTokens.type,
      pushEnabled: userSettings.notifyPushEnabled,
      ...(typeColumn ? { typeEnabled: typeColumn } : {}),
    })
    .from(pushTokens)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, pushTokens.userId))
    .where(and(inArray(pushTokens.userId, [...new Set(userIds)]), eq(pushTokens.enabled, true)));

  for (const row of rows as Array<{
    userId: string;
    token: string;
    type: string;
    pushEnabled: boolean | null;
    typeEnabled?: boolean | null;
  }>) {
    if (row.type !== 'fcm') continue;
    // `null` is "no settings row": the schema default, which is on.
    if (row.pushEnabled === false || row.typeEnabled === false) continue;
    const tokens = targets.get(row.userId);
    if (tokens) tokens.push(row.token);
    else targets.set(row.userId, [row.token]);
  }
  return targets;
}

/**
 * The notification fields a push body is built from.
 *
 * Structural rather than `typeof notifications.$inferSelect`: this is the whole
 * read surface, so the compiler rejects a caller that has not actually resolved
 * the row, and the function stays callable from a test with a literal. `id` is
 * the row's `text` primary key.
 */
export interface PushNotificationSource {
  id: string;
  type: string;
  entityId: string;
  entityType: string;
  actorId: string;
}

/**
 * What {@link formatPushForNotification} reads besides the row. A fan-out passes
 * memoized lookups so the actor and the post are resolved ONCE for every
 * recipient — the actor of a 200-subscriber post is the same person 200 times.
 */
export interface PushLookups {
  actor(actorId: string): Promise<{ name?: { displayName?: string | null } | null } | null>;
  post(postId: string): Promise<PostRecord | null>;
}

const directPushLookups: PushLookups = {
  actor: (actorId) => getServiceOxyClient().users.get(actorId),
  post: (postId) => loadPostRecord(postId),
};

export async function formatPushForNotification(
  n: PushNotificationSource,
  lookups: PushLookups = directPushLookups,
) {
  // Best-effort: hydrate actor for title/body
  let actorName = 'Someone';
  try {
    if (n.actorId && n.actorId !== 'system') {
      const actor = await lookups.actor(n.actorId);
      actorName = actor?.name?.displayName ?? actorName;
    } else if (n.actorId === 'system') {
      actorName = 'System';
    }
  } catch (error) {
    logger.debug('[Push] Failed to hydrate actor for notification, using fallback name', { error });
  }
  const map: Record<string, { title: string; body: string }> = {
    like: { title: 'New like', body: `${actorName} liked your post` },
    reply: { title: 'New reply', body: `${actorName} replied to your post` },
    mention: { title: 'You were mentioned', body: `${actorName} mentioned you` },
    boost: { title: 'Post boosted', body: `${actorName} boosted your post` },
    quote: { title: 'Post quoted', body: `${actorName} quoted your post` },
    follow: { title: 'New follower', body: `${actorName} followed you` },
    poke: { title: 'Poke!', body: `${actorName} poked you` },
    welcome: { title: 'Welcome to Mention', body: 'Thanks for joining!' },
    post: { title: 'New post', body: `${actorName} posted a new update` },
  };
  let f = map[n.type] || { title: 'Notification', body: 'You have a new notification' };
  let preview: string | undefined;
  // For post notifications, try to include a short preview in the push body.
  // Best-effort: a preview is a nicety, so every failure below is swallowed and
  // logged at debug. A push with a generic body is better than no push.
  try {
    if (n.type === 'post' && n.entityType === 'post' && n.entityId) {
      const post = await lookups.post(String(n.entityId));
      if (post) {
        // The primary rendition — a push has no viewer language context.
        const text: string = resolveVariant(post.content).text;
        preview = buildPreview(text, 200);
        if (preview) {
          f = { title: 'New post', body: `${actorName} posted: ${preview}` };
        }
      }
    }
  } catch (error) {
    logger.debug('[Push] Failed to build post preview for notification', { error });
  }
  const data: Record<string, string> = {
    type: String(n.type || ''),
    entityId: String(n.entityId || ''),
    entityType: String(n.entityType || ''),
    actorId: String(n.actorId || ''),
    notificationId: String(n.id || ''),
  };
  if (preview) data.preview = preview;
  return { title: f.title, body: f.body, data };
}
