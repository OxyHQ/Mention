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
}

/**
 * Shows notification permission prompt when needed (native only)
 */
export function NotificationPermissionGate({
  appIsReady,
}: NotificationPermissionGateProps) {
  const bs = useContext(BottomSheetContext);

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

    const timeout = setTimeout(run, INITIALIZATION_TIMEOUT.PERMISSION_PROMPT_DELAY);

    return () => {
      didCancel = true;
      clearTimeout(timeout);
    };
  }, [bs, appIsReady]);

  return null;
}

