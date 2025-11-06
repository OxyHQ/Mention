import { useState, useEffect } from 'react';
import { authenticatedClient } from '@/utils/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PRIVACY_SETTINGS_CACHE_KEY = '@mention_privacy_settings';

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

/**
 * Hook to fetch privacy settings for a specific user
 * @param userId - The Oxy user ID to fetch privacy settings for
 * @returns Privacy settings or null if not available
 */
export function usePrivacySettings(userId?: string | null): PrivacySettings | null {
    const [settings, setSettings] = useState<PrivacySettings | null>(null);

    useEffect(() => {
        if (!userId) {
            setSettings(null);
            return;
        }

        const loadSettings = async () => {
            try {
                const response = await authenticatedClient.get(`/profile/settings/${userId}`);
                if (response.data?.privacy) {
                    setSettings(response.data.privacy);
                } else {
                    // Default to public if no settings exist
                    setSettings({ profileVisibility: 'public', hideLikeCounts: false, hideShareCounts: false, hideReplyCounts: false, hideSaveCounts: false });
                }
            } catch (error: any) {
                // If 404, user might not have settings yet - use defaults
                if (error?.response?.status === 404) {
                    setSettings({ profileVisibility: 'public', hideLikeCounts: false, hideShareCounts: false, hideReplyCounts: false, hideSaveCounts: false });
                } else {
                    console.debug('Could not load privacy settings:', error);
                    setSettings(null);
                }
            }
        };

        loadSettings();
    }, [userId]);

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
                    console.debug('Failed to load cached privacy settings:', cacheErr);
                }
            })();
        }
        return null;
    });

    useEffect(() => {
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
                const response = await authenticatedClient.get('/profile/settings/me');
                if (response.data?.privacy) {
                    const freshSettings = response.data.privacy;
                    cachedPrivacySettings = freshSettings;
                    setSettings(freshSettings);
                    // Cache the settings for next time
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(freshSettings));
                    } catch (cacheErr) {
                        console.debug('Failed to cache privacy settings:', cacheErr);
                    }
                } else {
                    const defaultSettings = { profileVisibility: 'public' as const, hideLikeCounts: false, hideShareCounts: false, hideReplyCounts: false, hideSaveCounts: false };
                    cachedPrivacySettings = defaultSettings;
                    setSettings(defaultSettings);
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(defaultSettings));
                    } catch (cacheErr) {
                        console.debug('Failed to cache default privacy settings:', cacheErr);
                    }
                }
            } catch (error: any) {
                if (error?.response?.status === 404) {
                    const defaultSettings = { profileVisibility: 'public' as const, hideLikeCounts: false, hideShareCounts: false, hideReplyCounts: false, hideSaveCounts: false };
                    cachedPrivacySettings = defaultSettings;
                    setSettings(defaultSettings);
                    try {
                        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(defaultSettings));
                    } catch (cacheErr) {
                        console.debug('Failed to cache default privacy settings:', cacheErr);
                    }
                } else {
                    console.debug('Could not load current user privacy settings:', error);
                    // If we have cached settings, keep using them
                    if (!settings && cachedPrivacySettings) {
                        setSettings(cachedPrivacySettings);
                    } else if (!settings) {
                        setSettings({ profileVisibility: 'public', hideLikeCounts: false, hideShareCounts: false, hideReplyCounts: false, hideSaveCounts: false });
                    }
                }
            }
        };

        loadSettings();
    }, []);

    // Return settings (will be cached value immediately if available)
    return settings;
}

// Export function to update cache when settings change
export async function updatePrivacySettingsCache(privacySettings: PrivacySettings) {
    try {
        cachedPrivacySettings = privacySettings;
        await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(privacySettings));
    } catch (error) {
        console.debug('Failed to update privacy settings cache:', error);
    }
}

