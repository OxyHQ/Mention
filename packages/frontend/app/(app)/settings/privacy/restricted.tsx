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
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Icon } from '@/lib/icons';
import { useFocusEffect } from 'expo-router';
import { OxyAuthPrompt, queryKeys, useAuth } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { queryClient } from '@/lib/queryClient';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import MessageBottomSheet from '@/components/common/MessageBottomSheet';
import { EmptyState } from '@/components/common/EmptyState';
import { createScopedLogger } from '@/lib/logger';
import { usePrivacyStore } from '@/stores/privacyStore';

const restrictedLogger = createScopedLogger('RestrictedUsers');

interface RestrictedUser {
    id?: string;
    _id?: string;
    name?: User['name'];
    username?: string;
    handle?: string;
    // Populated from the SDK `User`/`SearchUserResult` (avatar is `string | null`).
    avatar?: string | null;
}

interface OxyProfileService {
    getProfileById?: (id: string) => Promise<User | null | undefined>;
    getProfile?: (id: string) => Promise<User | null | undefined>;
    getUserById?: (id: string) => Promise<User | null | undefined>;
    getUser?: (id: string) => Promise<User | null | undefined>;
}

const getUserId = (user: RestrictedUser): string | undefined => user.id || user._id;

export default function RestrictedUsersScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const {
        user: currentUser,
        isAuthenticated,
        isAuthResolved,
        canUsePrivateApi,
        isPrivateApiPending,
        oxyServices,
    } = useAuth();
    const bottomSheet = React.useContext(BottomSheetContext);
    // Authoritative cross-app sync: keep the shared privacy store in lockstep so
    // `usePrivacyControls().isRestricted` (which gates interactions everywhere)
    // reflects a restrict/unrestrict immediately, without waiting for the store's
    // interval refresh or a possibly-cached `getRestrictedUsers` refetch.
    const setStoreRestricted = usePrivacyStore((state) => state.setRestricted);
    const [restrictedUserIds, setRestrictedUserIds] = useState<string[]>([]);
    const [restrictedUsers, setRestrictedUsers] = useState<RestrictedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<RestrictedUser[]>([]);
    const [searching, setSearching] = useState(false);
    const [restricting, setRestricting] = useState<string | null>(null);

    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchAbortControllerRef = useRef<AbortController | null>(null);
    const restrictedUserIdsSet = useMemo(() => new Set(restrictedUserIds), [restrictedUserIds]);

    const loadRestrictedUsers = useCallback(async () => {
        if (!canUsePrivateApi) {
            restrictedLogger.debug('Not authenticated, skipping load');
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            restrictedLogger.debug('Loading restricted users...');
            const restrictedUsersList = await oxyServices.getRestrictedUsers();
            restrictedLogger.debug('Oxy response', { count: restrictedUsersList?.length });
            let userIds = (restrictedUsersList as unknown as Array<Record<string, unknown>>)
                .map((user) => {
                    const restrictedId = user.restrictedId as string | { _id?: string } | undefined;
                    if (restrictedId) {
                        return typeof restrictedId === 'string' ? restrictedId : restrictedId._id;
                    }
                    return (user.id || user._id || user.userId) as string | undefined;
                })
                .filter((id): id is string => Boolean(id));

            const currentUserId = currentUser?.id;
            if (currentUserId) {
                userIds = userIds.filter((id: string) => id !== currentUserId);
            }

            restrictedLogger.debug('Restricted user IDs filtered', { count: userIds.length });
            setRestrictedUserIds(userIds);

            if (userIds.length === 0) {
                setRestrictedUsers([]);
                setLoading(false);
                return;
            }

            const BATCH_SIZE = 10;
            const userPromises: Promise<RestrictedUser | null>[] = [];

            for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
                const batch = userIds.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(async (userId: string): Promise<RestrictedUser | null> => {
                    try {
                        restrictedLogger.debug(`Fetching user details for: ${userId}`);

                        const svc = oxyServices as unknown as OxyProfileService;
                        const loader = async (id: string): Promise<User | null | undefined> => {
                            if (typeof svc.getProfileById === 'function') {
                                try {
                                    return await svc.getProfileById(id);
                                } catch {
                                    restrictedLogger.debug(`getProfileById failed for ${id}`);
                                }
                            }
                            if (typeof svc.getProfile === 'function') {
                                try {
                                    return await svc.getProfile(id);
                                } catch {
                                    restrictedLogger.debug(`getProfile failed for ${id}`);
                                }
                            }
                            if (typeof svc.getUserById === 'function') {
                                try {
                                    return await svc.getUserById(id);
                                } catch {
                                    restrictedLogger.debug(`getUserById failed for ${id}`);
                                }
                            }
                            if (typeof svc.getUser === 'function') {
                                try {
                                    return await svc.getUser(id);
                                } catch {
                                    restrictedLogger.debug(`getUser failed for ${id}`);
                                }
                            }
                            return null;
                        };

                        const user = await queryClient.fetchQuery<User | null | undefined>({
                            queryKey: queryKeys.users.detail(String(userId)),
                            queryFn: () => loader(String(userId)),
                            staleTime: 5 * 60 * 1000,
                        });
                        restrictedLogger.debug(`Found user for ${userId}: ${user ? 'yes' : 'no'}`);

                        if (!user) return null;

                        return user;
                    } catch (error) {
                        restrictedLogger.warn(`Failed to fetch user ${userId}`, { error });
                        return null;
                    }
                });
                userPromises.push(...batchPromises);
            }

            const users = (await Promise.all(userPromises)).filter((user): user is User => Boolean(user));
            restrictedLogger.debug(`Loaded ${users.length} users`);
            setRestrictedUsers(users);
        } catch (error) {
            const err = error as { response?: { data?: unknown } };
            restrictedLogger.error('Error loading restricted users', { error, responseData: err.response?.data });
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
    }, [t, currentUser?.id, canUsePrivateApi, bottomSheet, oxyServices]);

    useFocusEffect(
        useCallback(() => {
            if (canUsePrivateApi) {
                loadRestrictedUsers();
            }
        }, [loadRestrictedUsers, canUsePrivateApi])
    );

    useEffect(() => {
        if (canUsePrivateApi) {
            loadRestrictedUsers();
        }
    }, [canUsePrivateApi, loadRestrictedUsers]);

    const performSearch = useCallback(async (query: string) => {
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
                    restrictedLogger.warn('oxyServices.searchProfiles failed, falling back', { error: oxyError });
                    const fallbackResults = await searchService.searchUsers(query);
                    results = fallbackResults.filter((user) => Boolean(user.name));
                }
            } else {
                const fallbackResults = await searchService.searchUsers(query);
                results = fallbackResults.filter((user) => Boolean(user.name));
            }

            if (abortController.signal.aborted) {
                return;
            }

            const filtered = results.filter((user) => {
                const userId = getUserId(user);
                return userId &&
                       !restrictedUserIdsSet.has(userId) &&
                       userId !== currentUser?.id;
            });
            setSearchResults(filtered);
        } catch (error) {
            const err = error as { name?: string };
            if (err.name !== 'AbortError') {
                restrictedLogger.error('Error searching users', { error });
            }
        } finally {
            if (!abortController.signal.aborted) {
                setSearching(false);
            }
        }
    }, [restrictedUserIdsSet, currentUser?.id, oxyServices]);

    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);

        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!query.trim()) {
            setSearchResults([]);
            setSearching(false);
            return;
        }

        searchTimeoutRef.current = setTimeout(() => {
            performSearch(query);
        }, 300);
    }, [performSearch]);

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
        const userId = getUserId(user);
        if (!userId) return;

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

            setRestrictedUserIds(prev => [...prev, userId]);
            setRestrictedUsers(prev => [...prev, user]);

            setSearchResults(prev => prev.filter(u => getUserId(u) !== userId));
            await oxyServices.restrictUser(userId);
            restrictedLogger.debug('User restricted successfully');

            setStoreRestricted(userId, true);

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
        } catch (error) {
            const err = error as { response?: { data?: { error?: string } } };
            restrictedLogger.error('Error restricting user', { error });
            setRestrictedUserIds(prev => prev.filter(id => id !== userId));
            setRestrictedUsers(prev => prev.filter(u => getUserId(u) !== userId));
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
        const userToRemove = restrictedUsers.find(u => getUserId(u) === userId);

        const performUnrestrict = async () => {
            try {
                restrictedLogger.debug(`Unrestricting user: ${userId}`);

                setRestrictedUserIds(prev => prev.filter(id => id !== userId));
                setRestrictedUsers(prev => prev.filter(u => getUserId(u) !== userId));

                await oxyServices.unrestrictUser(userId);
                restrictedLogger.debug('User unrestricted successfully');

                setStoreRestricted(userId, false);

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
            } catch (error) {
                const err = error as { response?: { data?: { error?: string } } };
                restrictedLogger.error('Error unrestricting user', { error, responseData: err.response?.data });
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

        bottomSheet.setBottomSheetContent(
            <ConfirmBottomSheet
                title={t('settings.privacy.unrestrictUser')}
                message={t('settings.privacy.unrestrictUserConfirm')}
                confirmText={t('settings.privacy.unrestrict')}
                cancelText={t('common.cancel')}
                destructive
                onConfirm={performUnrestrict}
                onCancel={() => bottomSheet.openBottomSheet(false)}
            />
        );
        bottomSheet.openBottomSheet(true);
    };

    if (!isAuthResolved || isPrivateApiPending) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.restrictedUsers'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <View className="flex-1 items-center justify-center">
                    <Loading />
                </View>
            </ThemedView>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.restrictedProfiles'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <OxyAuthPrompt
                    label={t('settings.privacy.restricted.signInRequired', { defaultValue: 'Sign in to manage restricted accounts' })}
                    description={t('settings.privacy.restricted.signInRequiredDesc', { defaultValue: 'Restricted accounts can interact with you but their replies are hidden by default.' })}
                />
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.restrictedProfiles'),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup>
                    <View className="px-4 py-3.5 flex-row items-center gap-3">
                        <Icon name="information-circle" size={20} color={colors.primary} />
                        <Text className="flex-1 text-[13px] text-foreground">
                            {t('settings.privacy.restrictedUsersDescription')}
                        </Text>
                    </View>
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.privacy.searchUsersToRestrict')}>
                    <View className="px-4 py-3 flex-row items-center gap-3">
                        <Icon name="search" size={20} color={colors.textSecondary} />
                        <TextInput
                            className="flex-1 text-[15px] text-foreground"
                            placeholder={t('settings.privacy.searchUsersToRestrict')}
                            placeholderTextColor={colors.textSecondary}
                            value={searchQuery}
                            onChangeText={handleSearch}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        {searching && (
                            <Loading className="text-primary" size="small" style={{ flex: undefined }} />
                        )}
                    </View>
                </SettingsListGroup>

                {searchQuery.length > 0 && searchResults.length > 0 && (
                    <SettingsListGroup>
                        {searchResults.map((user) => {
                            const userId = getUserId(user);
                            const handle = user.username || user.handle || '';
                            const isRestricting = restricting === userId;
                            if (!userId || !user.name?.displayName) return null;

                            return (
                                <SettingsListItem
                                    key={userId}
                                    icon={<Avatar source={user.avatar} size={36} />}
                                    title={user.name.displayName}
                                    description={`@${handle}`}
                                    onPress={() => !isRestricting && handleRestrict(user)}
                                    disabled={isRestricting}
                                    showChevron={false}
                                    rightElement={
                                        isRestricting ? (
                                            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                                        ) : (
                                            <Icon name="add-circle" size={22} color={colors.primary} />
                                        )
                                    }
                                />
                            );
                        })}
                    </SettingsListGroup>
                )}

                {searchQuery.length > 0 && !searching && searchResults.length === 0 && (
                    <View className="py-4 items-center">
                        <Text className="text-sm text-muted-foreground">
                            {t('settings.privacy.noUsersFound')}
                        </Text>
                    </View>
                )}

                <SettingsListGroup title={t('settings.privacy.restrictedUsers')}>
                    {loading ? (
                        <View className="py-10 items-center">
                            <Loading className="text-primary" size="large" style={{ flex: undefined }} />
                        </View>
                    ) : restrictedUsers.length === 0 ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('settings.privacy.noRestrictedUsers')}
                                icon={{
                                    name: 'people-outline',
                                    size: 48,
                                }}
                            />
                        </View>
                    ) : (
                        restrictedUsers.map((user) => {
                            const userId = getUserId(user);
                            const handle = user.username || user.handle || '';
                            if (!userId || !user.name?.displayName) return null;

                            return (
                                <SettingsListItem
                                    key={userId}
                                    icon={<Avatar source={user.avatar} size={40} />}
                                    title={user.name.displayName}
                                    description={`@${handle}`}
                                    showChevron={false}
                                    rightElement={
                                        <TouchableOpacity
                                            className="px-3 py-1.5 rounded-lg"
                                            style={{ backgroundColor: colors.error + '20' }}
                                            activeOpacity={0.7}
                                            onPress={() => {
                                                if (userId) {
                                                    handleUnrestrict(userId);
                                                } else {
                                                    restrictedLogger.error('No userId found for user', { user });
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
                                            <Text className="text-[13px] font-semibold" style={{ color: colors.error }}>
                                                {t('settings.privacy.unrestrict')}
                                            </Text>
                                        </TouchableOpacity>
                                    }
                                />
                            );
                        })
                    )}
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
