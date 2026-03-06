import admin from 'firebase-admin';
import PushToken from '../models/PushToken';
import Post from '../models/Post';
import { oxy } from '../../server';
import { logger } from './logger';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const credsB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!credsB64 || !projectId) {
    logger.warn('[Push] Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID');
    return;
  }
  try {
    const json = Buffer.from(credsB64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    } as any);
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

// Helper to safely create a concise single-line preview
function buildPreview(text: string, limit: number = 200): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
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
    const tokens = await PushToken.find({ userId, enabled: true }).lean();
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
            const code = (r.error as any)?.errorInfo?.code || r.error?.code;
            if (code && (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))) {
              const bad = tkChunk[idx];
              if (bad) toDisable.push(bad);
            }
          }
        });
      }
    }
    if (toDisable.length) {
      await PushToken.updateMany({ token: { $in: toDisable } }, { enabled: false });
      logger.info(`[Push] Disabled invalid push tokens: ${toDisable.length}`);
    }
  } catch (e) {
    logger.error('[Push] Failed to send push:', e);
  }
}

export async function formatPushForNotification(n: any) {
  // Best-effort: hydrate actor for title/body
  let actorName = 'Someone';
  try {
    if (n.actorId && n.actorId !== 'system') {
      const actor = await oxy.getUserById(n.actorId);
      actorName = actor?.name?.full || actor?.username || actorName;
    } else if (n.actorId === 'system') {
      actorName = 'System';
    }
  } catch {}
  const map: Record<string, { title: string; body: string }> = {
    like: { title: 'New like', body: `${actorName} liked your post` },
    reply: { title: 'New reply', body: `${actorName} replied to your post` },
    mention: { title: 'You were mentioned', body: `${actorName} mentioned you` },
    repost: { title: 'Post reposted', body: `${actorName} reposted your post` },
    quote: { title: 'Post quoted', body: `${actorName} quoted your post` },
    follow: { title: 'New follower', body: `${actorName} followed you` },
    poke: { title: 'Poke!', body: `${actorName} poked you` },
    welcome: { title: 'Welcome to Mention', body: 'Thanks for joining!' },
    post: { title: 'New post', body: `${actorName} posted a new update` },
  };
  let f = map[n.type] || { title: 'Notification', body: 'You have a new notification' };
  let preview: string | undefined;
  // For post notifications, try to include a short preview in the push body
  try {
    if (n.type === 'post' && n.entityType === 'post' && n.entityId) {
      const post: any = await Post.findById(n.entityId, { 'content.text': 1 }).lean();
      if (post) {
        const text: string = post?.content?.text || '';
        preview = buildPreview(text, 200);
        if (preview) {
          f = { title: 'New post', body: `${actorName} posted: ${preview}` };
        }
      }
    }
  } catch {}
  const data: Record<string, string> = {
    type: String(n.type || ''),
    entityId: String((n as any).entityId || ''),
    entityType: String(n.entityType || ''),
    actorId: String(n.actorId || ''),
    notificationId: String(n._id || ''),
  };
  if (preview) data.preview = preview;
  return { title: f.title, body: f.body, data };
}
