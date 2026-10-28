import { useEffect } from 'react';
import { Platform } from 'react-native';
import { logger } from '@oxy.so/core/logger';

import { presentSheet } from '@/utils/sheet';
import { Storage } from '@/utils/storage';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import {
  canOfferNotificationPermission,
  requestNotificationPermissions,
} from '@/utils/notifications';
import { INITIALIZATION_TIMEOUT, STORAGE_KEYS } from '@/lib/constants';

// Multiple roots/StrictMode must not race the read → presentation sequence.
let educationInProgress = false;

/** One device-local education prompt; explicit settings can request permission later. */
export function NotificationPermissionGate({ appIsReady }: { appIsReady: boolean }) {
  useEffect(() => {
    if (Platform.OS === 'web' || !appIsReady) return;
    let cancelled = false;
    let dismiss: (() => void) | undefined;

    const run = async () => {
      if (cancelled || educationInProgress) return;
      educationInProgress = true;
      try {
        if (await Storage.get<boolean>(STORAGE_KEYS.NOTIFICATION_EDUCATION_SHOWN)) return;
        if (cancelled || !(await canOfferNotificationPermission()) || cancelled) return;
        // Persist presentation, including swipe/back dismissal and an OS denial.
        // Without durable storage, skip unsolicited education instead of nagging.
        if (!(await Storage.set(STORAGE_KEYS.NOTIFICATION_EDUCATION_SHOWN, true)) || cancelled)
          return;
        let requesting = false;
        await presentSheet((surface) => {
          dismiss = () => surface.dismiss();
          return (
            <NotificationPermissionSheet
              onLater={() => surface.dismiss()}
              onEnable={async () => {
                if (cancelled || requesting) return;
                requesting = true;
                try {
                  await requestNotificationPermissions();
                } catch (error) {
                  logger.warn('Failed to request notification permission', { error });
                } finally {
                  surface.dismiss();
                }
              }}
            />
          );
        });
      } catch (error) {
        logger.warn('Failed to prepare notification education', { error });
      } finally {
        educationInProgress = false;
      }
    };
    const timeout = setTimeout(() => void run(), INITIALIZATION_TIMEOUT.PERMISSION_PROMPT_DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      dismiss?.();
    };
  }, [appIsReady]);
  return null;
}
