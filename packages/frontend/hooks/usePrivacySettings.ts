import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';
import { createScopedLogger } from '@/lib/logger';
import { useAuth } from '@oxyhq/services/ui/client';
import type { FeedSettings } from '@/hooks/useFeedSettings';
import type { ExternalEmbedsSettings } from '@mention/shared-types';
import {
    viewerStorageKey,
    type ViewerId,
} from '@/lib/viewerQueryKeys';
import { createKeyedAsyncQueue } from '@/lib/keyedAsyncQueue';

const logger = createScopedLogger('usePrivacySettings');

const LEGACY_PRIVACY_SETTINGS_CACHE_KEY = '@mention_privacy_settings';
const PRIVACY_SETTINGS_CACHE_KEY = '@mention_privacy_settings:v2';

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
    profileVisibility: 'public',
    hideLikeCounts: false,
    hideShareCounts: false,
    hideReplyCounts: false,
    hideSaveCounts: false,
    showSensitiveContent: false,
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
    showSensitiveContent?: boolean;
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
    externalEmbeds?: ExternalEmbedsSettings;
    /**
     * The author's default PRIMARY content language (canonical BCP-47), applied
     * as `content.variants[0]` — the rendition that federates and is the post's
     * "face". Absent ⇒ no global preference; the composer opens on the UI locale
     * and leaves detection to the server.
     */
    fediversePreferredLanguage?: string;
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
const cachedPrivacySettingsByViewer = new Map<string, PrivacySettings>();
const privacyCacheLoadPromises = new Map<
    string,
    Promise<PrivacySettings | null>
>();
const privacyCacheEpochs = new Map<string, number>();
const enqueuePrivacyStorage = createKeyedAsyncQueue();

export interface PrivacySettingsCacheLease {
    readonly viewerId: string;
    readonly epoch: number;
}

function normalizePrivateViewerId(viewerId: ViewerId): string | null {
    const normalized = viewerId?.trim();
    return normalized || null;
}

function privacyCacheStorageKey(viewerId: string): string {
    return viewerStorageKey(PRIVACY_SETTINGS_CACHE_KEY, viewerId);
}

function privacyCacheEpoch(viewerId: string): number {
    return privacyCacheEpochs.get(viewerId) ?? 0;
}

/**
 * Capture ownership before starting a settings mutation. Passing this lease to
 * the cache write prevents an old request from A from repopulating A's private
 * persistence after A → B → A transitions.
 */
export function createPrivacySettingsCacheLease(
    viewerId: ViewerId,
): PrivacySettingsCacheLease | null {
    const normalizedViewerId = normalizePrivateViewerId(viewerId);
    if (!normalizedViewerId) return null;
    return {
        viewerId: normalizedViewerId,
        epoch: privacyCacheEpoch(normalizedViewerId),
    };
}

function removeLegacyPrivacySettingsCache(): void {
    // The v1 payload has no owner. Never assign it to the next account that
    // happens to authenticate on this device.
    void AsyncStorage
        .removeItem(LEGACY_PRIVACY_SETTINGS_CACHE_KEY)
        .catch(() => {});
}

async function loadCachedPrivacySettings(
    viewerId: string,
): Promise<PrivacySettings | null> {
    const existing = cachedPrivacySettingsByViewer.get(viewerId);
    if (existing) return existing;

    const pending = privacyCacheLoadPromises.get(viewerId);
    if (pending) return pending;

    removeLegacyPrivacySettingsCache();
    const operationEpoch = privacyCacheEpoch(viewerId);
    const loadPromise = (async () => {
        try {
            const cached = await enqueuePrivacyStorage(
                viewerId,
                async () => {
                    if (operationEpoch !== privacyCacheEpoch(viewerId)) {
                        return null;
                    }
                    return AsyncStorage.getItem(
                        privacyCacheStorageKey(viewerId),
                    );
                },
            );
            if (operationEpoch !== privacyCacheEpoch(viewerId) || !cached) {
                return null;
            }
            const parsed = JSON.parse(cached) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return null;
            }
            const settings = parsed as PrivacySettings;
            cachedPrivacySettingsByViewer.set(viewerId, settings);
            return settings;
        } catch (cacheErr) {
            logger.debug('Failed to load cached privacy settings', {
                error: cacheErr,
            });
            return null;
        }
    })();
    privacyCacheLoadPromises.set(viewerId, loadPromise);
    try {
        return await loadPromise;
    } finally {
        if (privacyCacheLoadPromises.get(viewerId) === loadPromise) {
            privacyCacheLoadPromises.delete(viewerId);
        }
    }
}

async function persistPrivacySettings(
    viewerId: string,
    privacySettings: PrivacySettings,
    operationEpoch = privacyCacheEpoch(viewerId),
): Promise<void> {
    if (operationEpoch !== privacyCacheEpoch(viewerId)) return;
    const storageKey = privacyCacheStorageKey(viewerId);
    await enqueuePrivacyStorage(viewerId, async () => {
        if (operationEpoch !== privacyCacheEpoch(viewerId)) return;
        cachedPrivacySettingsByViewer.set(viewerId, privacySettings);
        await AsyncStorage.setItem(
            storageKey,
            JSON.stringify(privacySettings),
        );
        if (operationEpoch !== privacyCacheEpoch(viewerId)) {
            cachedPrivacySettingsByViewer.delete(viewerId);
        }
    });
}

export function useCurrentUserPrivacySettings(): PrivacySettings | null {
    const {
        isAuthenticated,
        isAuthResolved,
        canUsePrivateApi,
        isPrivateApiPending,
        user,
    } = useAuth();
    const viewerId = normalizePrivateViewerId(user?.id);
    const [settings, setSettings] = useState<PrivacySettings | null>(
        () => viewerId
            ? cachedPrivacySettingsByViewer.get(viewerId) ?? null
            : null,
    );

    useEffect(() => {
        if (!isAuthResolved || isPrivateApiPending) {
            return;
        }

        if (!canUsePrivateApi || !viewerId) {
            setSettings(DEFAULT_PRIVACY_SETTINGS);
            return;
        }

        let cancelled = false;
        const operationEpoch = privacyCacheEpoch(viewerId);
        const isCurrentViewer = () =>
            !cancelled &&
            operationEpoch === privacyCacheEpoch(viewerId);

        const loadSettings = async () => {
            const cached = await loadCachedPrivacySettings(viewerId);
            if (!isCurrentViewer()) return;
            if (cached) {
                setSettings(cached);
            }

            try {
                const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
                if (!isCurrentViewer()) return;
                const freshSettings =
                    response.data?.privacy ?? DEFAULT_PRIVACY_SETTINGS;
                setSettings(freshSettings);
                await persistPrivacySettings(
                    viewerId,
                    freshSettings,
                    operationEpoch,
                );
            } catch (error: unknown) {
                if (!isCurrentViewer()) return;
                if (isUnauthorizedError(error)) {
                    setSettings(cached ?? DEFAULT_PRIVACY_SETTINGS);
                    return;
                }
                if (isNotFoundError(error)) {
                    setSettings(DEFAULT_PRIVACY_SETTINGS);
                    await persistPrivacySettings(
                        viewerId,
                        DEFAULT_PRIVACY_SETTINGS,
                        operationEpoch,
                    );
                } else {
                    logger.debug('Could not load current user privacy settings');
                    setSettings((current) =>
                        current ?? cached ?? DEFAULT_PRIVACY_SETTINGS);
                }
            }
        };

        void loadSettings();
        return () => {
            cancelled = true;
        };
    }, [
        canUsePrivateApi,
        isAuthResolved,
        isAuthenticated,
        isPrivateApiPending,
        viewerId,
    ]);

    return settings;
}

export async function updatePrivacySettingsCache(
    privacySettings: PrivacySettings,
    lease: PrivacySettingsCacheLease | null,
) {
    if (
        !lease ||
        lease.epoch !== privacyCacheEpoch(lease.viewerId)
    ) {
        return;
    }

    removeLegacyPrivacySettingsCache();
    try {
        await persistPrivacySettings(
            lease.viewerId,
            privacySettings,
            lease.epoch,
        );
    } catch (error: unknown) {
        logger.debug('Failed to update privacy settings cache', { error });
    }
}

/** Invalidate pending work and remove the previous viewer's private cache. */
export function resetCurrentUserPrivacySettingsCache(viewerId: ViewerId): void {
    const normalizedViewerId = normalizePrivateViewerId(viewerId);
    if (!normalizedViewerId) return;

    privacyCacheEpochs.set(
        normalizedViewerId,
        privacyCacheEpoch(normalizedViewerId) + 1,
    );
    cachedPrivacySettingsByViewer.delete(normalizedViewerId);
    privacyCacheLoadPromises.delete(normalizedViewerId);
    removeLegacyPrivacySettingsCache();
    void enqueuePrivacyStorage(
        normalizedViewerId,
        () => AsyncStorage.removeItem(
            privacyCacheStorageKey(normalizedViewerId),
        ),
    )
        .catch(() => {});
}
