import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { searchService } from '@/services/searchService';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import MessageBottomSheet from '@/components/common/MessageBottomSheet';
import { EmptyState } from '@/components/common/EmptyState';

// Production check - disable verbose logging in production
const IS_DEV = __DEV__;
const log = IS_DEV ? console.log : () => {};
const logError = IS_DEV ? console.error : () => {};
const logWarn = IS_DEV ? console.warn : () => {};

const IconComponent = Ionicons as React.ComponentType<{ name: string; size?: number; color?: string; style?: object }>;

interface RestrictedUser {
    id: string;
    name?: string | { full?: string; first?: string; last?: string };
    username?: string;
    handle?: string;
    avatar?: string;
}

export default function RestrictedUsersScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { user: currentUser, isAuthenticated, oxyServices } = useAuth();
    const bottomSheet = React.useContext(BottomSheetContext);
    const [restrictedUserIds, setRestrictedUserIds] = useState<string[]>([]);
    const [restrictedUsers, setRestrictedUsers] = useState<RestrictedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<RestrictedUser[]>([]);
    const [searching, setSearching] = useState(false);
    const [restricting, setRestricting] = useState<string | null>(null);

    // Performance optimizations
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchAbortControllerRef = useRef<AbortController | null>(null);
    const restrictedUserIdsSet = useMemo(() => new Set(restrictedUserIds), [restrictedUserIds]);

    const loadRestrictedUsers = useCallback(async () => {
        if (!isAuthenticated) {
            log('[RestrictedUsers] Not authenticated, skipping load');
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            log('[RestrictedUsers] Loading restricted users...');
            // Use Oxy services directly
            const restrictedUsersList = await oxyServices.getRestrictedUsers();
            log('[RestrictedUsers] Oxy response:', restrictedUsersList);
            // Extract user IDs from RestrictedUser objects (restrictedId can be string or object)
            const userIds = (restrictedUsersList as Array<{ restrictedId?: string | { _id: string }; id?: string; _id?: string; userId?: string }>)
                .map((user) => {
                    if (user.restrictedId) {
                        return typeof user.restrictedId === 'string' ? user.restrictedId : user.restrictedId._id;
                    }
                    return user.id || user._id || user.userId;
                })
                .filter(Boolean)
                .filter((id): id is string => id !== currentUser?.id) as string[];

            log('[RestrictedUsers] Restricted user IDs (filtered):', userIds);
            setRestrictedUserIds(userIds);

            if (userIds.length === 0) {
                setRestrictedUsers([]);
                setLoading(false);
                return;
            }

            // Batch user lookups with concurrency limit for better performance
            const BATCH_SIZE = 10;
            const userPromises: Promise<RestrictedUser>[] = [];

            for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
                const batch = userIds.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(async (userId: string) => {
                    try {
                        log(`[RestrictedUsers] Fetching user details for: ${userId}`);

                        // Use usersStore's ensureById which tries multiple methods and caches
                        const { useUsersStore } = await import('@/stores/usersStore');
                        const usersState = useUsersStore.getState();

                        const svc = oxyServices as Record<string, unknown>;
                        const loader = async (id: string): Promise<RestrictedUser | null | undefined> => {
                            // Try multiple methods like NotificationItem does
                            if (typeof svc.getProfileById === 'function') {
                                try {
                                    return await (svc.getProfileById as (id: string) => Promise<RestrictedUser>)(id);
                                } catch (e) {
                                    log(`[RestrictedUsers] getProfileById failed for ${id}`);
                                }
                            }
                            if (typeof svc.getProfile === 'function') {
                                try {
                                    return await (svc.getProfile as (id: string) => Promise<RestrictedUser>)(id);
                                } catch (e) {
                                    log(`[RestrictedUsers] getProfile failed for ${id}`);
                                }
                            }
                            if (typeof svc.getUserById === 'function') {
                                try {
                                    return await (svc.getUserById as (id: string) => Promise<RestrictedUser>)(id);
                                } catch (e) {
                                    log(`[RestrictedUsers] getUserById failed for ${id}`);
                                }
                            }
                            if (typeof svc.getUser === 'function') {
                                try {
                                    return await (svc.getUser as (id: string) => Promise<RestrictedUser>)(id);
                                } catch (e) {
                                    log(`[RestrictedUsers] getUser failed for ${id}`);
                                }
                            }
                            return null;
                        };

                        const user = await usersState.ensureById(String(userId), loader);
                        log(`[RestrictedUsers] Found user for ${userId}:`, user ? 'yes' : 'no');

                        // If we couldn't fetch user details, create a minimal user object
                        if (!user) {
                            log(`[RestrictedUsers] Creating fallback user object for ${userId}`);
                            return {
                                id: userId,
                                username: userId.substring(0, 8) + '...',
                                handle: userId.substring(0, 8) + '...',
                            } as RestrictedUser;
                        }

                        return user;
                    } catch (error) {
                        logWarn(`[RestrictedUsers] Failed to fetch user ${userId}:`, error);
                        // Return fallback user object instead of null
                        return {
                            id: userId,
                            username: userId.substring(0, 8) + '...',
                            handle: userId.substring(0, 8) + '...',
                        } as RestrictedUser;
                    }
                });
                userPromises.push(...batchPromises);
            }

            const users = (await Promise.all(userPromises)).filter(Boolean) as RestrictedUser[];
            log('[RestrictedUsers] Loaded users:', users.length);
            setRestrictedUsers(users);
        } catch (error: unknown) {
            const err = error as { response?: { data?: unknown } };
            logError('[RestrictedUsers] Error loading restricted users:', error);
            logError('[RestrictedUsers] Error response:', err.response?.data);
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.error')}
                    message={t('settings.privacy.failedToLoadRestrictedUsers')}
                    type="error"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        } finally {
            setLoading(false);
        }
    }, [t, currentUser?.id, isAuthenticated, bottomSheet, oxyServices]);

    useFocusEffect(
        useCallback(() => {
            if (isAuthenticated) {
                loadRestrictedUsers();
            }
        }, [loadRestrictedUsers, isAuthenticated])
    );

    // Reload when authentication becomes available
    useEffect(() => {
        if (isAuthenticated) {
            loadRestrictedUsers();
        }
    }, [isAuthenticated, loadRestrictedUsers]);

    // Debounced search with request cancellation
    const performSearch = useCallback(async (query: string) => {
        // Cancel previous search request
        if (searchAbortControllerRef.current) {
            searchAbortControllerRef.current.abort();
        }

        if (!query.trim()) {
            setSearchResults([]);
            setSearching(false);
            return;
        }

        const abortController = new AbortController();
        searchAbortControllerRef.current = abortController;

        try {
            setSearching(true);
            let results: RestrictedUser[] = [];
            if (oxyServices?.searchProfiles) {
                try {
                    const { data } = await oxyServices.searchProfiles(query, { limit: 20 });
                    results = Array.isArray(data) ? data : [];
                } catch (oxyError) {
                    logWarn('[RestrictedUsers] oxyServices.searchProfiles failed, falling back:', oxyError);
                    results = await searchService.searchUsers(query);
                }
            } else {
                results = await searchService.searchUsers(query);
            }

            // Check if request was cancelled
            if (abortController.signal.aborted) {
                return;
            }

            // Filter out already restricted users and current user using Set for O(1) lookup
            const filtered = results.filter((user) => {
                const userId = user.id;
                return userId &&
                       !restrictedUserIdsSet.has(userId) &&
                       userId !== currentUser?.id;
            });
            setSearchResults(filtered);
        } catch (error: unknown) {
            const err = error as { name?: string };
            // Ignore abort errors
            if (err.name !== 'AbortError') {
                logError('Error searching users:', error);
            }
        } finally {
            if (!abortController.signal.aborted) {
                setSearching(false);
            }
        }
    }, [restrictedUserIdsSet, currentUser?.id, oxyServices]);

    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);

        // Clear existing timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!query.trim()) {
            setSearchResults([]);
            setSearching(false);
            return;
        }

        // Debounce search by 300ms
        searchTimeoutRef.current = setTimeout(() => {
            performSearch(query);
        }, 300);
    }, [performSearch]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
            if (searchAbortControllerRef.current) {
                searchAbortControllerRef.current.abort();
            }
        };
    }, []);

    const handleRestrict = async (user: RestrictedUser) => {
        const userId = user.id;
        if (!userId) return;

        // Prevent restricting yourself
        if (currentUser?.id === userId) {
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.error')}
                    message={t('settings.privacy.cannotRestrictYourself')}
                    type="error"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
            return;
        }

        try {
            setRestricting(userId);

            // Optimistically update the state
            setRestrictedUserIds(prev => [...prev, userId]);
            setRestrictedUsers(prev => [...prev, user]);

            // Remove from search results immediately
            setSearchResults(prev => prev.filter(u => u.id !== userId));
            // Use Oxy services directly
            await oxyServices.restrictUser(userId);
            log('[RestrictedUsers] User restricted successfully');

            // Reload from server to ensure consistency
            await loadRestrictedUsers();

            setSearchQuery('');
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.success')}
                    message={t('settings.privacy.userRestricted')}
                    type="success"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        } catch (error: unknown) {
            const err = error as { response?: { data?: { error?: string } } };
            logError('Error restricting user:', error);
            // Revert optimistic update on error
            setRestrictedUserIds(prev => prev.filter(id => id !== userId));
            setRestrictedUsers(prev => prev.filter(u => u.id !== userId));
            const errorMessage = err.response?.data?.error || t('settings.privacy.failedToRestrictUser');
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.error')}
                    message={errorMessage}
                    type="error"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        } finally {
            setRestricting(null);
        }
    };

    const handleUnrestrict = async (userId: string) => {
        // Store user to remove for potential revert
        const userToRemove = restrictedUsers.find(u => u.id === userId);

        const performUnrestrict = async () => {
            try {
                log('[RestrictedUsers] Unrestricting user:', userId);

                // Optimistically remove from list
                setRestrictedUserIds(prev => prev.filter(id => id !== userId));
                setRestrictedUsers(prev => prev.filter(u => u.id !== userId));

                // Use Oxy services directly
                await oxyServices.unrestrictUser(userId);
                log('[RestrictedUsers] User unrestricted successfully');

                // Reload from server to ensure consistency
                await loadRestrictedUsers();

                bottomSheet.setBottomSheetContent(
                    <MessageBottomSheet
                        title={t('common.success')}
                        message={t('settings.privacy.userUnrestricted')}
                        type="success"
                        onClose={() => bottomSheet.openBottomSheet(false)}
                    />
                );
                bottomSheet.openBottomSheet(true);
            } catch (error: unknown) {
                const err = error as { response?: { data?: { error?: string } } };
                logError('[RestrictedUsers] Error unrestricting user:', error);
                logError('[RestrictedUsers] Error response:', err.response?.data);
                // Revert optimistic update on error
                if (userToRemove) {
                    setRestrictedUserIds(prev => [...prev, userId]);
                    setRestrictedUsers(prev => [...prev, userToRemove]);
                }
                const errorMessage = err.response?.data?.error || t('settings.privacy.failedToUnrestrictUser');
                bottomSheet.setBottomSheetContent(
                    <MessageBottomSheet
                        title={t('common.error')}
                        message={errorMessage}
                        type="error"
                        onClose={() => bottomSheet.openBottomSheet(false)}
                    />
                );
                bottomSheet.openBottomSheet(true);
            }
        };

        // Show confirmation bottom sheet
        bottomSheet.setBottomSheetContent(
            <ConfirmBottomSheet
                title={t('settings.privacy.unrestrictUser')}
                message={t('settings.privacy.unrestrictUserConfirm')}
                confirmText={t('settings.privacy.unrestrict')}
                cancelText={t('common.cancel')}
                destructive={true}
                onConfirm={performUnrestrict}
                onCancel={() => bottomSheet.openBottomSheet(false)}
            />
        );
        bottomSheet.openBottomSheet(true);
    };

    // Memoized helper functions for better performance
    const getUserDisplayName = useCallback((user: RestrictedUser) => {
        if (typeof user.name === 'string') return user.name;
        if (user.name?.full) return user.name.full;
        if (user.name?.first) return `${user.name.first} ${user.name.last || ''}`.trim();
        return user.username || user.handle || '';
    }, []);

    const getUserHandle = useCallback((user: RestrictedUser) => {
        return user.username || user.handle || '';
    }, []);

    const getAvatarUri = useCallback((user: RestrictedUser) => {
        return user.avatar;
    }, []);

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.restrictedProfiles'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => safeBack()}
                        >
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                {/* Info Card */}
                <View className="flex-row items-start rounded-2xl border border-border bg-card p-4 mb-5 gap-3">
                    <IconComponent name="information-circle" size={20} color={colors.primary} />
                    <Text className="flex-1 text-sm leading-5 text-muted-foreground">
                        {t('settings.privacy.restrictedUsersDescription')}
                    </Text>
                </View>

                {/* Search Section */}
                <View className="mb-6">
                    <View className="flex-row items-center rounded-2xl border border-border bg-card px-3 py-2.5 mb-3">
                        <IconComponent name="search" size={20} color={colors.textSecondary} style={{ marginRight: 8 }} />
                        <TextInput
                            className="flex-1 text-base text-foreground"
                            placeholder={t('settings.privacy.searchUsersToRestrict')}
                            placeholderTextColor={colors.textSecondary}
                            value={searchQuery}
                            onChangeText={handleSearch}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        {searching && (
                            <Loading size="small" style={{ flex: undefined, marginLeft: 8 }} />
                        )}
                    </View>

                    {/* Search Results */}
                    {searchQuery && searchResults.length > 0 && (
                        <View className="rounded-2xl border border-border bg-card overflow-hidden" style={{ maxHeight: 300 }}>
                            {searchResults.map((user) => {
                                const userId = user.id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);
                                const isRestricting = restricting === userId;

                                return (
                                    <TouchableOpacity
                                        key={userId}
                                        className="flex-row items-center py-3 border-b border-border"
                                        onPress={() => !isRestricting && handleRestrict(user)}
                                        disabled={isRestricting}
                                    >
                                        <Avatar
                                            source={avatarUri}
                                            size={40}
                                        />
                                        <View className="flex-1 ml-3">
                                            <Text className="text-base font-medium mb-0.5 text-foreground">
                                                {displayName}
                                            </Text>
                                            <Text className="text-sm text-muted-foreground">
                                                @{handle}
                                            </Text>
                                        </View>
                                        {isRestricting ? (
                                            <Loading variant="inline" size="small" style={{ flex: undefined }} />
                                        ) : (
                                            <IconComponent name="add-circle" size={24} color={colors.primary} />
                                        )}
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}

                    {searchQuery && !searching && searchResults.length === 0 && (
                        <View className="py-4 items-center">
                            <Text className="text-sm text-muted-foreground">
                                {t('settings.privacy.noUsersFound')}
                            </Text>
                        </View>
                    )}
                </View>

                {/* Restricted Users List */}
                <View className="mt-2">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
                        {t('settings.privacy.restrictedUsers')}
                    </Text>

                    {loading ? (
                        <View className="py-10 items-center">
                            <Loading size="large" style={{ flex: undefined }} />
                        </View>
                    ) : restrictedUsers.length === 0 ? (
                        <EmptyState
                            title={t('settings.privacy.noRestrictedUsers')}
                            icon={{
                                name: 'people-outline',
                                size: 48,
                            }}
                        />
                    ) : (
                        <View className="rounded-2xl border border-border bg-card overflow-hidden">
                            {restrictedUsers.map((user, index) => {
                                const userId = user.id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);

                                return (
                                    <View key={userId}>
                                        <View className="flex-row items-center px-4 py-4">
                                            <Avatar
                                                source={avatarUri}
                                                size={48}
                                            />
                                            <View className="flex-1 ml-3">
                                                <Text className="text-base font-medium mb-0.5 text-foreground">
                                                    {displayName}
                                                </Text>
                                                <Text className="text-sm text-muted-foreground">
                                                    @{handle}
                                                </Text>
                                            </View>
                                            <TouchableOpacity
                                                className="px-4 py-2 rounded-lg"
                                                style={{ backgroundColor: colors.error + '20' }}
                                                activeOpacity={0.7}
                                                onPress={() => {
                                                    log('[RestrictedUsers] Unrestrict button pressed for userId:', userId, 'user:', user);
                                                    if (userId) {
                                                        handleUnrestrict(userId);
                                                    } else {
                                                        logError('[RestrictedUsers] No userId found for user:', user);
                                                        bottomSheet.setBottomSheetContent(
                                                            <MessageBottomSheet
                                                                title={t('common.error')}
                                                                message="Invalid user ID"
                                                                type="error"
                                                                onClose={() => bottomSheet.openBottomSheet(false)}
                                                            />
                                                        );
                                                        bottomSheet.openBottomSheet(true);
                                                    }
                                                }}
                                            >
                                                <Text className="text-sm font-semibold" style={{ color: colors.error }}>
                                                    {t('settings.privacy.unrestrict')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                        {index < restrictedUsers.length - 1 && (
                                            <View className="h-px mx-4 bg-border" />
                                        )}
                                    </View>
                                );
                            })}
                        </View>
                    )}
                </View>
            </ScrollView>
        </ThemedView>
    );
}
