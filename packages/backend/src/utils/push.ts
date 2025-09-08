import admin from 'firebase-admin';
import PushToken from '../models/PushToken';
import Post from '../models/Post';
import { oxy } from '../../server';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const credsB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!credsB64 || !projectId) {
    console.warn('Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID');
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
    console.log('Firebase Admin initialized for FCM');
  } catch (e) {
    console.error('Failed to initialize Firebase Admin:', e);
  }
}

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export async function sendPushToUser(userId: string, payload: PushPayload) {
  initFirebase();
  if (!firebaseInitialized) return;
  try {
    const tokens = await PushToken.find({ userId, enabled: true }).lean();
    if (!tokens.length) return;
    const fcmTokens = tokens.filter(t => t.type === 'fcm').map(t => t.token);
    if (!fcmTokens.length) return;
    const message: admin.messaging.MulticastMessage = {
      tokens: fcmTokens,
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
    // Cleanup invalid tokens
    if (resp.responses) {
      const toDisable: string[] = [];
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = (r.error as any)?.errorInfo?.code || r.error?.code;
          if (code && (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))) {
            const bad = fcmTokens[idx];
            if (bad) toDisable.push(bad);
          }
        }
      });
      if (toDisable.length) {
        await PushToken.updateMany({ token: { $in: toDisable } }, { enabled: false });
        console.log('Disabled invalid push tokens:', toDisable.length);
      }
    }
  } catch (e) {
    console.error('Failed to send push:', e);
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
        const trimmed = typeof text === 'string' ? text.trim() : '';
        preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
        if (preview) {
          f = { title: 'New post', body: `${actorName} posted: ${preview}` };
        }
      }
    }
  } catch {}
  const data: Record<string, string> = {
    type: n.type,
    entityId: n.entityId,
    entityType: n.entityType,
    actorId: n.actorId,
    notificationId: String(n._id || ''),
  };
  if (preview) data.preview = preview;
  return { title: f.title, body: f.body, data };
}
