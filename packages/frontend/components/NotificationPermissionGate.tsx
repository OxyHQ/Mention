/**
 * NotificationPermissionGate Component
 * Extracted from _layout.tsx for better organization
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';

import { presentSheet } from '@/utils/sheet';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';

interface NotificationPermissionGateProps {
  appIsReady: boolean;
}

/**
 * Shows notification permission prompt when needed (native only)
 */
export function NotificationPermissionGate({ appIsReady }: NotificationPermissionGateProps) {
  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    let didCancel = false;

    const run = async () => {
      if (!appIsReady) {
        return;
      }

      const hasPerm = await hasNotificationPermission();
      if (didCancel || hasPerm) {
        return;
      }

      void presentSheet((surface) => (
        <NotificationPermissionSheet
          onLater={() => surface.dismiss()}
          onEnable={async () => {
            const granted = await requestNotificationPermissions();
            surface.dismiss();
            if (granted) {
              // token registration handled by <RegisterPush />
            }
          }}
        />
      ));
    };

    const timeout = setTimeout(run, INITIALIZATION_TIMEOUT.PERMISSION_PROMPT_DELAY);

    return () => {
      didCancel = true;
      clearTimeout(timeout);
    };
  }, [appIsReady]);

  return null;
}
