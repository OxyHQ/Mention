import admin from 'firebase-admin';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeInlineText } from '@oxyhq/core';
import { getFirebaseConfig } from '../config';
import { getDb } from '../db/postgres';
import { pushTokens } from '../db/schema/discovery';
import { resolveVariant } from '../services/postVariants';
import { loadPostRecord } from '../db/posts/postRepository';
import { getServiceOxyClient } from './oxyHelpers';
import { logger } from './logger';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const firebase = getFirebaseConfig();
  if (!firebase) {
    logger.warn('[Push] Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID');
    return;
  }
  try {
    const json = Buffer.from(firebase.serviceAccountBase64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(json) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  initFirebase();
  if (!firebaseInitialized) return;
  try {
    // Served by `push_tokens_user_enabled_idx`, the partial index on enabled
    // rows. The `type` filter stays in memory exactly as before: a device is
    // one row, so the set is tiny and no index would earn its keep.
    const tokens = await getDb()
      .select({ token: pushTokens.token, type: pushTokens.type })
      .from(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.enabled, true)));
    if (!tokens.length) return;
    const fcmTokens = tokens.filter(t => t.type === 'fcm').map(t => t.token);
    if (!fcmTokens.length) return;

    const tokenChunks = chunk(fcmTokens, 500); // FCM limit per multicast
    const toDisable: string[] = [];
    for (const tkChunk of tokenChunks) {
      const message: admin.messaging.MulticastMessage = {
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
      const resp = await admin.messaging().sendEachForMulticast(message);
      // Cleanup invalid tokens in this chunk
      if (resp.responses) {
        resp.responses.forEach((r, idx) => {
          if (!r.success) {
            const errorInfo = r.error && 'errorInfo' in r.error
              ? (r.error as { errorInfo?: { code?: string } }).errorInfo
              : undefined;
            const code = errorInfo?.code || r.error?.code;
            if (code && (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))) {
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
 * The notification fields a push body is built from.
 *
 * Structural rather than `typeof notifications.$inferSelect`: this is the whole
 * read surface, so the compiler rejects a caller that has not actually resolved
 * the row, and the function stays callable from a test with a literal. `id`
 * replaces Mongoose's `_id` — the value it carries is the same one, since the
 * backfill copies `_id` verbatim into the `text` primary key.
 */
export interface PushNotificationSource {
  id: string;
  type: string;
  entityId: string;
  entityType: string;
  actorId: string;
}

export async function formatPushForNotification(n: PushNotificationSource) {
  // Best-effort: hydrate actor for title/body
  let actorName = 'Someone';
  try {
    if (n.actorId && n.actorId !== 'system') {
      const actor = await getServiceOxyClient().getUserById(n.actorId);
      actorName = actor?.name.displayName ?? actorName;
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
    channel_invite: { title: 'Channel invite', body: `${actorName} invited you to publish to a channel` },
  };
  let f = map[n.type] || { title: 'Notification', body: 'You have a new notification' };
  let preview: string | undefined;
  // For post notifications, try to include a short preview in the push body.
  // The POST row is deliberately still read from Mongo: `posts` and
  // `resolveVariant`'s content shape belong to the posts batch, and reading a
  // half-migrated table here would produce an empty preview rather than an error.
  try {
    if (n.type === 'post' && n.entityType === 'post' && n.entityId) {
      const post = await loadPostRecord(String(n.entityId));
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
