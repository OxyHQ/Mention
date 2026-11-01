import { Platform } from 'react-native';
import { logger } from '@oxy.so/core/logger';

// Do not statically import 'expo-notifications' to avoid bundling it on web.
// Use a cached dynamic import so the package is only loaded on native platforms.
let notificationsModule: typeof import('expo-notifications') | null = null;
async function getNotifications(): Promise<typeof import('expo-notifications') | null> {
  if (Platform.OS === 'web') return null;
  if (!notificationsModule) {
    notificationsModule = await import('expo-notifications');
  }
  return notificationsModule;
}

export async function requestNotificationPermissions() {
  const Notifications = await getNotifications();
  if (!Notifications) return false;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/** Education is only appropriate before the first OS permission decision. */
export async function canOfferNotificationPermission(): Promise<boolean> {
  const Notifications = await getNotifications();
  if (!Notifications) return false;
  const permission = await Notifications.getPermissionsAsync();
  return permission.status === 'undetermined' && permission.canAskAgain;
}

export async function createNotification(
  title: string,
  body: string,
  data: Record<string, unknown> = {},
) {
  const Notifications = await getNotifications();
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
    },
    trigger: null, // Shows notification immediately
  });
}

export async function setupNotifications() {
  const Notifications = await getNotifications();
  if (!Notifications) return;
  // The handler first: from SDK 58 a notification that arrives in the
  // foreground before any handler is installed is shown with the module's
  // defaults, so nothing may be awaited ahead of it.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  // Android channel setup for high-importance notifications
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        showBadge: true,
      });
    } catch (e) {
      logger.warn('Failed to set Android notification channel', { error: e });
    }
  }
}

/** The string fields Mention's push payload carries (`backend/src/utils/push.ts`). */
export type PushNotificationData = Record<string, string>;

/**
 * Responses already acted on, by notification identifier. Module-scoped so a
 * remount, or the cold-start response also arriving through the listener,
 * never opens the same push twice.
 */
const handledPushOpens = new Set<string>();

type PushOpenModule = Pick<
  typeof import('expo-notifications'),
  | 'DEFAULT_ACTION_IDENTIFIER'
  | 'addNotificationResponseReceivedListener'
  | 'getLastNotificationResponse'
  | 'clearLastNotificationResponse'
>;

/**
 * Call `onOpen` with the payload of every push the user taps: the one that
 * launched the app from cold, and each one tapped while it runs. Dismissals
 * and other actions are ignored. Returns the unsubscribe.
 */
export function watchPushOpens(
  Notifications: PushOpenModule,
  onOpen: (data: PushNotificationData) => void,
): () => void {
  const handle = (response: import('expo-notifications').NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { request } = response.notification;
    if (handledPushOpens.has(request.identifier)) return;
    handledPushOpens.add(request.identifier);
    Notifications.clearLastNotificationResponse();
    // An FCM notification tapped from the tray carries its data on the remote
    // message; one presented in the foreground carries it on the content.
    const remote = (request.trigger as { remoteMessage?: { data?: unknown } } | null)?.remoteMessage
      ?.data;
    const data: PushNotificationData = {};
    for (const source of [remote, request.content.data]) {
      if (!source || typeof source !== 'object') continue;
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') data[key] = value;
      }
    }
    onOpen(data);
  };

  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  handle(Notifications.getLastNotificationResponse());
  return () => subscription.remove();
}

/** {@link watchPushOpens} on native; a no-op on web, where there is no push. */
export async function subscribeToPushOpens(
  onOpen: (data: PushNotificationData) => void,
): Promise<() => void> {
  const Notifications = await getNotifications();
  return Notifications ? watchPushOpens(Notifications, onOpen) : () => undefined;
}

export type DevicePushToken = { token: string; type: 'fcm' | 'apns' | 'unknown' } | null;

export async function getDevicePushToken(): Promise<DevicePushToken> {
  const Notifications = await getNotifications();
  if (!Notifications) return null;
  try {
    // On Android managed builds with FCM configured, this returns the FCM token.
    // expo-notifications is dynamically imported (untyped here), so narrow the
    // returned token to the two shapes we read across SDK versions.
    const devicePushToken: { data?: string; token?: string; type?: string } | null | undefined =
      await Notifications.getDevicePushTokenAsync();
    const defaultType = Platform.OS === 'ios' ? 'apns' : 'fcm';
    if (devicePushToken?.data) {
      const type =
        devicePushToken.type === 'apns' || devicePushToken.type === 'fcm'
          ? devicePushToken.type
          : defaultType;
      return { token: devicePushToken.data, type };
    }
    // Fallback shape on some SDK versions
    if (devicePushToken?.token) {
      const type =
        devicePushToken.type === 'apns' || devicePushToken.type === 'fcm'
          ? devicePushToken.type
          : defaultType;
      return { token: devicePushToken.token, type };
    }
  } catch (e) {
    logger.warn('Failed to get device push token', { error: e });
  }
  return null;
}
