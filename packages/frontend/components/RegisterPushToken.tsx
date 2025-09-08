import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useOxy } from '@oxyhq/services';
import { authenticatedClient } from '@/utils/api';
import { getData } from '@/utils/storage';
import { getDevicePushToken } from '@/utils/notifications';
import i18next from 'i18next';

export const RegisterPushToken: React.FC = () => {
    const { isAuthenticated, user } = useOxy();
    const lastTokenRef = useRef<string | null>(null);

    useEffect(() => {
        let mounted = true;
        const register = async () => {
            if (!isAuthenticated) return;
            if (Platform.OS === 'web') return;
            // Remote push notifications are not supported in Expo Go starting with SDK 53
            if (Constants.appOwnership === 'expo') {
                console.warn('expo-notifications: Remote push is unavailable in Expo Go. Use a development build.');
                return;
            }
            // Honor persisted preference to avoid re-registering until re-enabled
            const storageKey = `pref:${user?.id || 'global'}:notificationsEnabled`;
            const enabledPref = await getData<boolean>(storageKey);
            if (enabledPref === false) {
                return;
            }
            try {
                const token = await getDevicePushToken();
                if (!mounted || !token?.token) return;
                if (lastTokenRef.current === token.token) return; // avoid duplicate
                await authenticatedClient.post('/notifications/push-token', {
                    token: token.token,
                    type: token.type || (Platform.OS === 'ios' ? 'apns' : 'fcm'),
                    platform: Platform.OS,
                    locale: i18next.language,
                });
                lastTokenRef.current = token.token;
            } catch (e) {
                console.warn('Failed to register push token:', e);
            }
        };
        register();
        return () => { mounted = false; };
    }, [isAuthenticated, user?.id]);

    return null;
};

export default RegisterPushToken;
