/**
 * NotificationPermissionGate Component
 * Extracted from _layout.tsx for better organization
 */

import React, { useContext, useEffect } from 'react';
import { Platform } from 'react-native';

import { BottomSheetContext } from '@/context/BottomSheetContext';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import {
  hasNotificationPermission,
  requestNotificationPermissions,
} from '@/utils/notifications';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';

interface NotificationPermissionGateProps {
  appIsReady: boolean;
  initializationComplete: boolean;
}

/**
 * Shows notification permission prompt when needed (native only)
 */
export function NotificationPermissionGate({
  appIsReady,
  initializationComplete,
}: NotificationPermissionGateProps) {
  const bs = useContext(BottomSheetContext);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    let didCancel = false;

    const run = async () => {
      if (!appIsReady || !initializationComplete) {
        return;
      }

      const hasPerm = await hasNotificationPermission();
      if (didCancel || hasPerm) {
        return;
      }

      bs.setBottomSheetContent(
        <NotificationPermissionSheet
          onLater={() => bs.openBottomSheet(false)}
          onEnable={async () => {
            const granted = await requestNotificationPermissions();
            bs.openBottomSheet(false);
            if (granted) {
              // token registration handled by <RegisterPush />
            }
          }}
        />
      );
      bs.openBottomSheet(true);
    };

    const timeout = setTimeout(run, INITIALIZATION_TIMEOUT.SPLASH_FADE_DELAY);

    return () => {
      didCancel = true;
      clearTimeout(timeout);
    };
  }, [bs, appIsReady, initializationComplete]);

  return null;
}

