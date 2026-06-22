import React, { useState, useCallback } from 'react';
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

const blockedLogger = createScopedLogger('BlockedUsers');

interface BlockedUser {
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

const getUserId = (user: BlockedUser): string | undefined => user.id || user._id;

export default function BlockedUsersScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const {
        user: currentUser,
        oxyServices,
        isAuthenticated,
        isAuthResolved,
        canUsePrivateApi,
        isPrivateApiPending,
    } = useAuth();
    const bottomSheet = React.useContext(BottomSheetContext);
    const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
    const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<BlockedUser[]>([]);
    const [searching, setSearching] = useState(false);
    const [blocking, setBlocking] = useState<string | null>(null);

    const loadBlockedUsers = useCallback(async () => {
        if (!oxyServices?.getBlockedUsers) {
            blockedLogger.warn('oxyServices.getBlockedUsers not available');
            setBlockedUsers([]);
            setBlockedUserIds([]);
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            blockedLogger.debug('Loading blocked users...');
            const blockedUsersList = await oxyServices.getBlockedUsers();
            blockedLogger.debug('Oxy response received', { count: blockedUsersList?.length });
            const userIds = (blockedUsersList as unknown as Array<Record<string, unknown>>)
                .map((user) => {
                    const blockedId = user.blockedId as string | { _id?: string } | undefined;
                    if (blockedId) {
                        return typeof blockedId === 'string' ? blockedId : blockedId._id;
                    }
                    return (user.id || user._id || user.userId) as string | undefined;
                })
                .filter((id): id is string => Boolean(id));
            blockedLogger.debug('Blocked user IDs resolved', { count: userIds.length });
            setBlockedUserIds(userIds);

            if (userIds.length === 0) {
                setBlockedUsers([]);
                setLoading(false);
                return;
            }

            const userPromises = userIds.map(async (userId: string): Promise<BlockedUser | null> => {
                try {
                    blockedLogger.debug(`Fetching user details for: ${userId}`);

                    const svc = oxyServices as unknown as OxyProfileService;
                    const loader = async (id: string): Promise<User | null | undefined> => {
                        if (typeof svc.getProfileById === 'function') {
                            try {
                                return await svc.getProfileById(id);
                            } catch {
                                blockedLogger.debug(`getProfileById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getProfile === 'function') {
                            try {
                                return await svc.getProfile(id);
                            } catch {
                                blockedLogger.debug(`getProfile failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUserById === 'function') {
                            try {
                                return await svc.getUserById(id);
                            } catch {
                                blockedLogger.debug(`getUserById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUser === 'function') {
                            try {
                                return await svc.getUser(id);
                            } catch {
                                blockedLogger.debug(`getUser failed for ${id}`);
                            }
                        }
                        return null;
                    };

                    const user = await queryClient.fetchQuery<User | null | undefined>({
                        queryKey: queryKeys.users.detail(String(userId)),
                        queryFn: () => loader(String(userId)),
                        staleTime: 5 * 60 * 1000,
                    });
                    blockedLogger.debug(`Found user for ${userId}: ${user ? 'yes' : 'no'}`);

                    if (!user) return null;

                    return user;
                } catch (error) {
                    blockedLogger.warn(`Failed to fetch user ${userId}`, { error });
                    return null;
                }
            });

            const users = (await Promise.all(userPromises)).filter((user): user is User => Boolean(user));
            blockedLogger.debug(`Loaded users: ${users.length}`);
            setBlockedUsers(users);
        } catch (error) {
            const err = error as { response?: { data?: unknown } };
            blockedLogger.error('Error loading blocked users', { error, responseData: err.response?.data });
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.error')}
                    message={t('settings.privacy.failedToLoadBlockedUsers')}
                    type="error"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        } finally {
            setLoading(false);
        }
    }, [t, bottomSheet, oxyServices]);

    useFocusEffect(
        useCallback(() => {
            if (!canUsePrivateApi) return;
            loadBlockedUsers();
        }, [canUsePrivateApi, loadBlockedUsers])
    );

    const searchUsersViaOxy = useCallback(async (query: string): Promise<BlockedUser[]> => {
        if (oxyServices?.searchProfiles) {
            try {
                const { data } = await oxyServices.searchProfiles(query, { limit: 20 });
                return Array.isArray(data) ? data : [];
            } catch (error) {
                blockedLogger.warn('oxyServices.searchProfiles failed, falling back', { error });
            }
        }
        const results = await searchService.searchUsers(query);
        return results.filter((user) => Boolean(user.name));
    }, [oxyServices]);

    const handleSearch = useCallback(async (query: string) => {
        setSearchQuery(query);
        if (!query.trim()) {
            setSearchResults([]);
            return;
        }

        try {
            setSearching(true);
            const results = await searchUsersViaOxy(query);
            const filtered = results.filter((user) => {
                const userId = getUserId(user);
                return userId &&
                       !blockedUserIds.includes(userId) &&
                       userId !== currentUser?.id;
            });
            setSearchResults(filtered);
        } catch (error) {
            blockedLogger.error('Error searching users', { error });
        } finally {
            setSearching(false);
        }
    }, [blockedUserIds, currentUser?.id, searchUsersViaOxy]);

    const handleBlock = async (user: BlockedUser) => {
        const userId = getUserId(user);
        if (!userId) return;

        if (currentUser?.id === userId) {
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.error')}
                    message={t('settings.privacy.cannotBlockYourself')}
                    type="error"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
            return;
        }

        try {
            setBlocking(userId);

            setBlockedUserIds(prev => [...prev, userId]);
            setBlockedUsers(prev => [...prev, user]);

            setSearchResults(prev => prev.filter(u => getUserId(u) !== userId));

            await oxyServices.blockUser(userId);
            blockedLogger.info('User blocked successfully');

            await loadBlockedUsers();

            setSearchQuery('');
            bottomSheet.setBottomSheetContent(
                <MessageBottomSheet
                    title={t('common.success')}
                    message={t('settings.privacy.userBlocked')}
                    type="success"
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        } catch (error) {
            const err = error as { response?: { data?: { error?: string } } };
            blockedLogger.error('Error blocking user', { error });
            setBlockedUserIds(prev => prev.filter(id => id !== userId));
            setBlockedUsers(prev => prev.filter(u => getUserId(u) !== userId));
            const errorMessage = err.response?.data?.error || t('settings.privacy.failedToBlockUser');
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
            setBlocking(null);
        }
    };

    const handleUnblock = async (userId: string) => {
        const userToRemove = blockedUsers.find(u => getUserId(u) === userId);

        const performUnblock = async () => {
            try {
                blockedLogger.debug(`Unblocking user: ${userId}`);

                setBlockedUserIds(prev => prev.filter(id => id !== userId));
                setBlockedUsers(prev => prev.filter(u => getUserId(u) !== userId));

                await oxyServices.unblockUser(userId);
                blockedLogger.info('User unblocked successfully');

                await loadBlockedUsers();

                bottomSheet.setBottomSheetContent(
                    <MessageBottomSheet
                        title={t('common.success')}
                        message={t('settings.privacy.userUnblocked')}
                        type="success"
                        onClose={() => bottomSheet.openBottomSheet(false)}
                    />
                );
                bottomSheet.openBottomSheet(true);
            } catch (error) {
                const err = error as { response?: { data?: { error?: string } } };
                blockedLogger.error('Error unblocking user', { error, responseData: err.response?.data });
                if (userToRemove) {
                    setBlockedUserIds(prev => [...prev, userId]);
                    setBlockedUsers(prev => [...prev, userToRemove]);
                }
                const errorMessage = err.response?.data?.error || t('settings.privacy.failedToUnblockUser');
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
                title={t('settings.privacy.unblockUser')}
                message={t('settings.privacy.unblockUserConfirm')}
                confirmText={t('settings.privacy.unblock')}
                cancelText={t('common.cancel')}
                destructive
                onConfirm={performUnblock}
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
                        title: t('settings.privacy.blockedUsers'),
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
                        title: t('settings.privacy.blockedProfiles'),
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
                    label={t('settings.privacy.blocked.signInRequired', { defaultValue: 'Sign in to manage blocked accounts' })}
                    description={t('settings.privacy.blocked.signInRequiredDesc', { defaultValue: 'You can block or unblock people once signed in.' })}
                />
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.blockedProfiles'),
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
                <SettingsListGroup title={t('settings.privacy.searchUsersToBlock')}>
                    <View className="px-4 py-3 flex-row items-center gap-3">
                        <Icon name="search" size={20} color={colors.textSecondary} />
                        <TextInput
                            className="flex-1 text-[15px] text-foreground"
                            placeholder={t('settings.privacy.searchUsersToBlock')}
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
                            const isBlocking = blocking === userId;
                            if (!userId || !user.name?.displayName) return null;

                            return (
                                <SettingsListItem
                                    key={userId}
                                    icon={<Avatar source={user.avatar} size={36} />}
                                    title={user.name.displayName}
                                    description={`@${handle}`}
                                    onPress={() => !isBlocking && handleBlock(user)}
                                    disabled={isBlocking}
                                    showChevron={false}
                                    rightElement={
                                        isBlocking ? (
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

                <SettingsListGroup title={t('settings.privacy.blockedUsers')}>
                    {loading ? (
                        <View className="py-10 items-center">
                            <Loading className="text-primary" size="large" style={{ flex: undefined }} />
                        </View>
                    ) : blockedUsers.length === 0 ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('settings.privacy.noBlockedUsers')}
                                icon={{
                                    name: 'people-outline',
                                    size: 48,
                                }}
                            />
                        </View>
                    ) : (
                        blockedUsers.map((user) => {
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
                                                    handleUnblock(userId);
                                                } else {
                                                    blockedLogger.error('No userId found for user');
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
                                                {t('settings.privacy.unblock')}
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
