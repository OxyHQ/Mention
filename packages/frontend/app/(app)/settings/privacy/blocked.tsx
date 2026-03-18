import React, { useState, useEffect, useCallback } from 'react';
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
import { createScopedLogger } from '@/lib/logger';

const blockedLogger = createScopedLogger('BlockedUsers');

const IconComponent = Ionicons as any;

interface BlockedUser {
    id: string;
    name?: string | { full?: string; first?: string; last?: string };
    username?: string;
    handle?: string;
    avatar?: string;
}

export default function BlockedUsersScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { user: currentUser, oxyServices } = useAuth();
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
            // Use Oxy services directly
            const blockedUsersList = await oxyServices.getBlockedUsers();
            blockedLogger.debug('Oxy response received', { count: blockedUsersList?.length });
            // Extract user IDs from BlockedUser objects (blockedId can be string or object)
            const userIds = blockedUsersList
                .map((user: any) => {
                    if (user.blockedId) {
                        return typeof user.blockedId === 'string' ? user.blockedId : user.blockedId._id;
                    }
                    return user.id || user._id || user.userId;
                })
                .filter(Boolean);
            blockedLogger.debug('Blocked user IDs resolved', { count: userIds.length });
            setBlockedUserIds(userIds);

            if (userIds.length === 0) {
                setBlockedUsers([]);
                setLoading(false);
                return;
            }

            // Fetch user details for each blocked user
            const userPromises = userIds.map(async (userId: string) => {
                try {
                    blockedLogger.debug(`Fetching user details for: ${userId}`);

                    // Use usersStore's ensureById which tries multiple methods
                    const { useUsersStore } = await import('@/stores/usersStore');
                    const usersState = useUsersStore.getState();

                    const svc: any = oxyServices as any;
                    const loader = async (id: string) => {
                        // Try multiple methods like NotificationItem does
                        if (typeof svc.getProfileById === 'function') {
                            try {
                                return await svc.getProfileById(id);
                            } catch (e) {
                                blockedLogger.debug(`getProfileById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getProfile === 'function') {
                            try {
                                return await svc.getProfile(id);
                            } catch (e) {
                                blockedLogger.debug(`getProfile failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUserById === 'function') {
                            try {
                                return await svc.getUserById(id);
                            } catch (e) {
                                blockedLogger.debug(`getUserById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUser === 'function') {
                            try {
                                return await svc.getUser(id);
                            } catch (e) {
                                blockedLogger.debug(`getUser failed for ${id}`);
                            }
                        }
                        return null;
                    };

                    const user = await usersState.ensureById(String(userId), loader);
                    blockedLogger.debug(`Found user for ${userId}: ${user ? 'yes' : 'no'}`);

                    // If we couldn't fetch user details, create a minimal user object
                    if (!user) {
                        blockedLogger.debug(`Creating fallback user object for ${userId}`);
                        return {
                            id: userId,
                            username: userId.substring(0, 8) + '...',
                            handle: userId.substring(0, 8) + '...',
                        } as BlockedUser;
                    }

                    return user;
                } catch (error) {
                    blockedLogger.warn(`Failed to fetch user ${userId}`, { error });
                    // Return fallback user object instead of null
                    return {
                        id: userId,
                        username: userId.substring(0, 8) + '...',
                        handle: userId.substring(0, 8) + '...',
                    } as BlockedUser;
                }
            });

            const users = (await Promise.all(userPromises)).filter(Boolean) as BlockedUser[];
            blockedLogger.debug(`Loaded users: ${users.length}`);
            setBlockedUsers(users);
        } catch (error: any) {
            blockedLogger.error('Error loading blocked users', { error, responseData: error.response?.data });
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
            loadBlockedUsers();
        }, [loadBlockedUsers])
    );

    const searchUsersViaOxy = useCallback(async (query: string) => {
        if (oxyServices?.searchProfiles) {
            try {
                const { data } = await oxyServices.searchProfiles(query, { limit: 20 });
                return Array.isArray(data) ? data : [];
            } catch (error) {
                blockedLogger.warn('oxyServices.searchProfiles failed, falling back', { error });
            }
        }
        return searchService.searchUsers(query);
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
            // Filter out already blocked users and current user
            const filtered = results.filter((user: any) => {
                const userId = user.id || user._id;
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
        const userId = user.id || (user as any)._id;
        if (!userId) return;

        // Prevent blocking yourself
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

            // Optimistically update the state
            setBlockedUserIds(prev => [...prev, userId]);
            setBlockedUsers(prev => [...prev, user]);

            // Remove from search results immediately
            setSearchResults(prev => prev.filter(u => {
                const id = u.id || (u as any)._id;
                return id !== userId;
            }));

            // Use Oxy services directly
            await oxyServices.blockUser(userId);
            blockedLogger.info('User blocked successfully');

            // Reload from server to ensure consistency
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
        } catch (error: any) {
            blockedLogger.error('Error blocking user', { error });
            // Revert optimistic update on error
            setBlockedUserIds(prev => prev.filter(id => id !== userId));
            setBlockedUsers(prev => prev.filter(u => {
                const id = u.id || (u as any)._id;
                return id !== userId;
            }));
            const errorMessage = error.response?.data?.error || t('settings.privacy.failedToBlockUser');
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
        // Store user to remove for potential revert
        const userToRemove = blockedUsers.find(u => {
            const id = u.id || (u as any)._id;
            return id === userId;
        });

        const performUnblock = async () => {
            try {
                blockedLogger.debug(`Unblocking user: ${userId}`);

                // Optimistically remove from list
                setBlockedUserIds(prev => prev.filter(id => id !== userId));
                setBlockedUsers(prev => prev.filter(u => {
                    const id = u.id || (u as any)._id;
                    return id !== userId;
                }));

                // Use Oxy services directly
                await oxyServices.unblockUser(userId);
                blockedLogger.info('User unblocked successfully');

                // Reload from server to ensure consistency
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
            } catch (error: any) {
                blockedLogger.error('Error unblocking user', { error, responseData: error.response?.data });
                // Revert optimistic update on error
                if (userToRemove) {
                    setBlockedUserIds(prev => [...prev, userId]);
                    setBlockedUsers(prev => [...prev, userToRemove]);
                }
                const errorMessage = error.response?.data?.error || t('settings.privacy.failedToUnblockUser');
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
                title={t('settings.privacy.unblockUser')}
                message={t('settings.privacy.unblockUserConfirm')}
                confirmText={t('settings.privacy.unblock')}
                cancelText={t('common.cancel')}
                destructive={true}
                onConfirm={performUnblock}
                onCancel={() => bottomSheet.openBottomSheet(false)}
            />
        );
        bottomSheet.openBottomSheet(true);
    };

    const getUserDisplayName = (user: BlockedUser) => {
        if (typeof user.name === 'string') return user.name;
        if (user.name?.full) return user.name.full;
        if (user.name?.first) return `${user.name.first} ${user.name.last || ''}`.trim();
        return user.username || user.handle || '';
    };

    const getUserHandle = (user: BlockedUser) => {
        return user.username || user.handle || '';
    };

    const getAvatarUri = (user: BlockedUser) => {
        return user.avatar;
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.blockedProfiles'),
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
                {/* Search Section */}
                <View className="mb-6">
                    <View className="flex-row items-center rounded-2xl border border-border bg-card px-3 py-2.5 mb-3">
                        <IconComponent name="search" size={20} color={colors.textSecondary} style={{ marginRight: 8 }} />
                        <TextInput
                            className="flex-1 text-base text-foreground"
                            placeholder={t('settings.privacy.searchUsersToBlock')}
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
                                const userId = user.id || (user as any)._id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);
                                const isBlocking = blocking === userId;

                                return (
                                    <TouchableOpacity
                                        key={userId}
                                        className="flex-row items-center py-3 border-b border-border"
                                        onPress={() => !isBlocking && handleBlock(user)}
                                        disabled={isBlocking}
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
                                        {isBlocking ? (
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

                {/* Blocked Users List */}
                <View className="mt-2">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
                        {t('settings.privacy.blockedUsers')}
                    </Text>

                    {loading ? (
                        <View className="py-10 items-center">
                            <Loading size="large" style={{ flex: undefined }} />
                        </View>
                    ) : blockedUsers.length === 0 ? (
                        <EmptyState
                            title={t('settings.privacy.noBlockedUsers')}
                            icon={{
                                name: 'people-outline',
                                size: 48,
                            }}
                        />
                    ) : (
                        <View className="rounded-2xl border border-border bg-card overflow-hidden">
                            {blockedUsers.map((user, index) => {
                                const userId = user.id || (user as any)._id;
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
                                                    blockedLogger.debug(`Unblock button pressed for userId: ${userId}`);
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
                                                <Text className="text-sm font-semibold" style={{ color: colors.error }}>
                                                    {t('settings.privacy.unblock')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                        {index < blockedUsers.length - 1 && (
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
