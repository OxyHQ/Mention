import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';
import { createScopedLogger } from '@/lib/logger';
import { useAuth } from '@oxyhq/services';
import type { FeedSettings } from '@/hooks/useFeedSettings';

const logger = createScopedLogger('usePrivacySettings');

const PRIVACY_SETTINGS_CACHE_KEY = '@mention_privacy_settings';

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
    profileVisibility: 'public',
    hideLikeCounts: false,
    hideShareCounts: false,
    hideReplyCounts: false,
    hideSaveCounts: false,
};

export interface PrivacySettings {
    profileVisibility?: 'public' | 'private' | 'followers_only';
    showContactInfo?: boolean;
    allowTags?: boolean;
    allowMentions?: boolean;
    showOnlineStatus?: boolean;
    hideLikeCounts?: boolean;
    hideShareCounts?: boolean;
    hideReplyCounts?: boolean;
    hideSaveCounts?: boolean;
    hiddenWords?: string[];
    restrictedUsers?: string[];
}

export interface AppearanceSettings {
    themeMode?: 'light' | 'dark' | 'system' | 'adaptive';
    primaryColor?: string;
}

export interface NotificationPreferences {
    pushEnabled?: boolean;
    emailEnabled?: boolean;
    likes?: boolean;
    boosts?: boolean;
    follows?: boolean;
    mentions?: boolean;
    replies?: boolean;
    quotes?: boolean;
}

/**
 * Wire shape returned by `GET /profile/settings/me` and
 * `GET /profile/settings/:userId` — mirrors the backend `UserSettings`
 * document. Every settings consumer types its `authenticatedClient.get`
 * call with this so response fields are not `unknown`.
 */
export interface UserSettingsResponse {
    oxyUserId?: string;
    appearance?: AppearanceSettings;
    profileHeaderImage?: string;
    privacy?: PrivacySettings;
    feedSettings?: FeedSettings;
    notificationPreferences?: NotificationPreferences;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Hook to fetch privacy settings for a specific user
 * @param userId - The Oxy user ID to fetch privacy settings for
 * @returns Privacy settings or null if not available
 */
export function usePrivacySettings(userId?: string | null): PrivacySettings | null {
    const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
    const [settings, setSettings] = useState<PrivacySettings | null>(null);

    useEffect(() => {
        if (!userId) {
            setSettings(null);
            return;
        }

        if (!isAuthResolved || isPrivateApiPending) {
            return;
        }

        if (!canUsePrivateApi) {
            setSettings(DEFAULT_PRIVACY_SETTINGS);
            return;
        }

        const loadSettings = async () => {
            try {
                const response = await authenticatedClient.get<UserSettingsResponse>(`/profile/settings/${userId}`);
                if (response.data?.privacy) {
                    setSettings(response.data.privacy);
                } else {
                    setSettings(DEFAULT_PRIVACY_SETTINGS);
                }
            } catch (error: unknown) {
                if (isNotFoundError(error)) {
                    setSettings(DEFAULT_PRIVACY_SETTINGS);
                } else {
                    logger.debug('Could not load privacy settings');
                    setSettings(null);
                }
            }
        };

        loadSettings();
    }, [canUsePrivateApi, isAuthResolved, isAuthenticated, isPrivateApiPending, userId]);

    return settings;
}

/**
 * Hook to fetch current user's privacy settings
 * @returns Current user's privacy settings
 */
// Cache for immediate access (loaded synchronously on first access)
let cachedPrivacySettings: PrivacySettings | null = null;
let cacheLoadPromise: Promise<void> | null = null;

export function useCurrentUserPrivacySettings(): PrivacySettings | null {
    const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
    const [settings, setSettings] = useState<PrivacySettings | null>(() => {
        // Try to load from cache synchronously on first render
        if (cachedPrivacySettings) {
            return cachedPrivacySettings;
        }
        // Start loading cache immediately
        if (!cacheLoadPromise) {
            cacheLoadPromise = (async () => {
                try {
                    const cached = await AsyncStorage.getItem(PRIVACY_SETTINGS_CACHE_KEY);
                    if (cached) {
                        cachedPrivacySettings = JSON.parse(cached);
                    }
                } catch (cacheErr) {
                    logger.debug('Failed to load cached privacy settings');
                }
            })();
        }
        return null;
    });

    useEffect(() => {
        if (!isAuthResolved || isPrivateApiPending) {
            return;
        }

        // Only make API call if user is authenticated
        if (!canUsePrivateApi) {
            // Use cached settings or defaults if not authenticated
            if (cacheLoadPromise) {
                cacheLoadPromise.then(() => {
                    setSettings(cachedPrivacySettings || DEFAULT_PRIVACY_SETTINGS);
                });
            } else {
                setSettings(cachedPrivacySettings || DEFAULT_PRIVACY_SETTINGS);
            }
            return;
        }

        const loadSettings = async () => {
            // Wait for initial cache load if it's still loading
            if (cacheLoadPromise) {
                await cacheLoadPromise;
                cacheLoadPromise = null;
                if (cachedPrivacySettings) {
                    setSettings(cachedPrivacySettings);
                }
            }

            // Then fetch fresh data from API
            try {
                const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
                if (response.data?.privacy) {
                    const freshSettings = response.data.privacy;
                    cachedPrivacySettings = freshSettings;
                    setSettings(freshSettings);
                    // Cache the settings for next time
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(freshSettings));
                    } catch (cacheErr: unknown) {
                        logger.debug('Failed to cache privacy settings', { error: cacheErr });
                    }
                } else {
                    cachedPrivacySettings = DEFAULT_PRIVACY_SETTINGS;
                    setSettings(DEFAULT_PRIVACY_SETTINGS);
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(DEFAULT_PRIVACY_SETTINGS));
                    } catch (cacheErr: unknown) {
                        logger.debug('Failed to cache default privacy settings', { error: cacheErr });
                    }
                }
            } catch (error: unknown) {
                if (isUnauthorizedError(error)) {
                    setSettings(cachedPrivacySettings || DEFAULT_PRIVACY_SETTINGS);
                    return;
                }
                if (isNotFoundError(error)) {
                    cachedPrivacySettings = DEFAULT_PRIVACY_SETTINGS;
                    setSettings(DEFAULT_PRIVACY_SETTINGS);
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(DEFAULT_PRIVACY_SETTINGS));
                    } catch (cacheErr: unknown) {
                        logger.debug('Failed to cache default privacy settings', { error: cacheErr });
                    }
                } else {
                    logger.debug('Could not load current user privacy settings');
                    setSettings((current) => current ?? cachedPrivacySettings ?? DEFAULT_PRIVACY_SETTINGS);
                }
            }
        };

        loadSettings();
    }, [canUsePrivateApi, isAuthResolved, isAuthenticated, isPrivateApiPending]);

    // Return settings (will be cached value immediately if available)
    return settings;
}

// Export function to update cache when settings change
export async function updatePrivacySettingsCache(privacySettings: PrivacySettings) {
    try {
        cachedPrivacySettings = privacySettings;
        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(privacySettings));
    } catch (error: unknown) {
        logger.debug('Failed to update privacy settings cache', { error });
    }
}
