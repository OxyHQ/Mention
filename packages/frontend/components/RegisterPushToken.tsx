import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useAuth } from '@oxy.so/services/ui/client';
import { authenticatedClient } from '@/utils/api';
import { Storage } from '@/utils/storage';
import { getDevicePushToken } from '@/utils/notifications';
import i18next from 'i18next';
import { logger } from '@oxy.so/core/logger';

export const RegisterPushToken: React.FC = () => {
    const { isAuthenticated, user } = useAuth();
    // Keyed by `${accountId}:${token}`, not by the device token alone. This
    // component stays mounted across an account switch (it lives in the app
    // shell, not per-session), and the PHYSICAL device token is often
    // identical across accounts on the same handset — keying by token alone
    // meant switching A → B with the same device token found `lastTokenRef`
    // already equal to it (from A's earlier registration) and skipped the
    // POST that would have registered B, leaving the row owned by A.
    const registeredRef = useRef<string | null>(null);

    useEffect(() => {
        if (!isAuthenticated || !user?.id) return;
        if (Platform.OS === 'web') return;
        // Remote push notifications are not supported in Expo Go starting with SDK 53
        if (Constants.appOwnership === 'expo') {
            logger.warn('expo-notifications: Remote push is unavailable in Expo Go. Use a development build.');
            return;
        }

        const accountId = user.id;
        // Set on cleanup, checked after every `await`: an account switch (or
        // unmount) mid-registration must not let THIS run's late POST result
        // overwrite `registeredRef` with a stale account/token pair after a
        // newer run has already started.
        let cancelled = false;

        const register = async () => {
            // Honor persisted preference to avoid re-registering until re-enabled
            const enabledPref = await Storage.get<boolean>(`pref:${accountId}:notificationsEnabled`);
            if (cancelled || enabledPref === false) return;

            try {
                const token = await getDevicePushToken();
                if (cancelled || !token?.token) return;
                const registrationKey = `${accountId}:${token.token}`;
                if (registeredRef.current === registrationKey) return; // already registered THIS account on THIS device
                await authenticatedClient.post('/notifications/push-token', {
                    token: token.token,
                    type: token.type || (Platform.OS === 'ios' ? 'apns' : 'fcm'),
                    platform: Platform.OS,
                    locale: i18next.language,
                });
                if (!cancelled) registeredRef.current = registrationKey;
            } catch {
                logger.warn('Failed to register push token');
            }
        };
        void register();
        return () => { cancelled = true; };
    }, [isAuthenticated, user?.id]);

    return null;
};

export default RegisterPushToken;
