import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { searchService } from '@/services/searchService';
import Avatar from '@/components/Avatar';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useOxy } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import MessageBottomSheet from '@/components/common/MessageBottomSheet';

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
    const theme = useTheme();
    const { user: currentUser, oxyServices } = useOxy();
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
            console.warn('[BlockedUsers] oxyServices.getBlockedUsers not available');
            setBlockedUsers([]);
            setBlockedUserIds([]);
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            console.log('[BlockedUsers] Loading blocked users...');
            // Use Oxy services directly
            const blockedUsersList = await oxyServices.getBlockedUsers();
            console.log('[BlockedUsers] Oxy response:', blockedUsersList);
            // Extract user IDs from BlockedUser objects (blockedId can be string or object)
            const userIds = blockedUsersList
                .map((user: any) => {
                    if (user.blockedId) {
                        return typeof user.blockedId === 'string' ? user.blockedId : user.blockedId._id;
                    }
                    return user.id || user._id || user.userId;
                })
                .filter(Boolean);
            console.log('[BlockedUsers] Blocked user IDs:', userIds);
            setBlockedUserIds(userIds);

            if (userIds.length === 0) {
                setBlockedUsers([]);
                setLoading(false);
                return;
            }

            // Fetch user details for each blocked user
            const userPromises = userIds.map(async (userId: string) => {
                try {
                    console.log(`[BlockedUsers] Fetching user details for: ${userId}`);

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
                                console.log(`[BlockedUsers] getProfileById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getProfile === 'function') {
                            try {
                                return await svc.getProfile(id);
                            } catch (e) {
                                console.log(`[BlockedUsers] getProfile failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUserById === 'function') {
                            try {
                                return await svc.getUserById(id);
                            } catch (e) {
                                console.log(`[BlockedUsers] getUserById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUser === 'function') {
                            try {
                                return await svc.getUser(id);
                            } catch (e) {
                                console.log(`[BlockedUsers] getUser failed for ${id}`);
                            }
                        }
                        return null;
                    };

                    const user = await usersState.ensureById(String(userId), loader);
                    console.log(`[BlockedUsers] Found user for ${userId}:`, user ? 'yes' : 'no', user);

                    // If we couldn't fetch user details, create a minimal user object
                    if (!user) {
                        console.log(`[BlockedUsers] Creating fallback user object for ${userId}`);
                        return {
                            id: userId,
                            username: userId.substring(0, 8) + '...',
                            handle: userId.substring(0, 8) + '...',
                        } as BlockedUser;
                    }

                    return user;
                } catch (error) {
                    console.warn(`[BlockedUsers] Failed to fetch user ${userId}:`, error);
                    // Return fallback user object instead of null
                    return {
                        id: userId,
                        username: userId.substring(0, 8) + '...',
                        handle: userId.substring(0, 8) + '...',
                    } as BlockedUser;
                }
            });

            const users = (await Promise.all(userPromises)).filter(Boolean) as BlockedUser[];
            console.log('[BlockedUsers] Loaded users:', users.length);
            setBlockedUsers(users);
        } catch (error: any) {
            console.error('[BlockedUsers] Error loading blocked users:', error);
            console.error('[BlockedUsers] Error response:', error.response?.data);
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
                console.warn('[BlockedUsers] oxyServices.searchProfiles failed, falling back:', error);
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
            console.error('Error searching users:', error);
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
            console.log('[BlockedUsers] User blocked successfully');

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
            console.error('Error blocking user:', error);
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
                console.log('[BlockedUsers] Unblocking user:', userId);

                // Optimistically remove from list
                setBlockedUserIds(prev => prev.filter(id => id !== userId));
                setBlockedUsers(prev => prev.filter(u => {
                    const id = u.id || (u as any)._id;
                    return id !== userId;
                }));

                // Use Oxy services directly
                await oxyServices.unblockUser(userId);
                console.log('[BlockedUsers] User unblocked successfully');

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
                console.error('[BlockedUsers] Error unblocking user:', error);
                console.error('[BlockedUsers] Error response:', error.response?.data);
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
        if (user.avatar) {
            return oxyServices.getFileDownloadUrl(user.avatar, 'thumb');
        }
        return undefined;
    };

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.blockedProfiles'),
                    leftComponents: [
                        <HeaderIconButton
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </HeaderIconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* Search Section */}
                <View style={styles.searchSection}>
                    <View style={[styles.searchInputContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <IconComponent name="search" size={20} color={theme.colors.textSecondary} style={styles.searchIcon} />
                        <TextInput
                            style={[styles.searchInput, { color: theme.colors.text }]}
                            placeholder={t('settings.privacy.searchUsersToBlock')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={searchQuery}
                            onChangeText={handleSearch}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        {searching && (
                            <ActivityIndicator size="small" color={theme.colors.primary} style={styles.searchLoader} />
                        )}
                    </View>

                    {/* Search Results */}
                    {searchQuery && searchResults.length > 0 && (
                        <View style={[styles.searchResults, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            {searchResults.map((user) => {
                                const userId = user.id || (user as any)._id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);
                                const isBlocking = blocking === userId;

                                return (
                                    <TouchableOpacity
                                        key={userId}
                                        style={[styles.searchResultItem, { borderBottomColor: theme.colors.border }]}
                                        onPress={() => !isBlocking && handleBlock(user)}
                                        disabled={isBlocking}
                                    >
                                        <Avatar
                                            source={avatarUri ? { uri: avatarUri } : undefined}
                                            size={40}
                                            label={displayName?.[0] || handle?.[0]}
                                        />
                                        <View style={styles.searchResultInfo}>
                                            <Text style={[styles.searchResultName, { color: theme.colors.text }]}>
                                                {displayName}
                                            </Text>
                                            <Text style={[styles.searchResultHandle, { color: theme.colors.textSecondary }]}>
                                                @{handle}
                                            </Text>
                                        </View>
                                        {isBlocking ? (
                                            <ActivityIndicator size="small" color={theme.colors.primary} />
                                        ) : (
                                            <IconComponent name="add-circle" size={24} color={theme.colors.primary} />
                                        )}
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}

                    {searchQuery && !searching && searchResults.length === 0 && (
                        <View style={styles.emptySearch}>
                            <Text style={[styles.emptySearchText, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.noUsersFound')}
                            </Text>
                        </View>
                    )}
                </View>

                {/* Blocked Users List */}
                <View style={styles.blockedSection}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('settings.privacy.blockedUsers')}
                    </Text>

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={theme.colors.primary} />
                        </View>
                    ) : blockedUsers.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <IconComponent name="people-outline" size={48} color={theme.colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.noBlockedUsers')}
                            </Text>
                        </View>
                    ) : (
                        <View style={[styles.blockedList, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            {blockedUsers.map((user, index) => {
                                const userId = user.id || (user as any)._id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);

                                return (
                                    <View key={userId}>
                                        <View style={styles.blockedUserItem}>
                                            <Avatar
                                                source={avatarUri ? { uri: avatarUri } : undefined}
                                                size={48}
                                                label={displayName?.[0] || handle?.[0]}
                                            />
                                            <View style={styles.blockedUserInfo}>
                                                <Text style={[styles.blockedUserName, { color: theme.colors.text }]}>
                                                    {displayName}
                                                </Text>
                                                <Text style={[styles.blockedUserHandle, { color: theme.colors.textSecondary }]}>
                                                    @{handle}
                                                </Text>
                                            </View>
                                            <TouchableOpacity
                                                style={[styles.unblockButton, { backgroundColor: theme.colors.error + '20' }]}
                                                activeOpacity={0.7}
                                                onPress={() => {
                                                    console.log('[BlockedUsers] Unblock button pressed for userId:', userId, 'user:', user);
                                                    if (userId) {
                                                        handleUnblock(userId);
                                                    } else {
                                                        console.error('[BlockedUsers] No userId found for user:', user);
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
                                                <Text style={[styles.unblockButtonText, { color: theme.colors.error }]}>
                                                    {t('settings.privacy.unblock')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                        {index < blockedUsers.length - 1 && (
                                            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
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

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 24,
    },
    searchSection: {
        marginBottom: 24,
    },
    searchInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 16,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 12,
    },
    searchIcon: {
        marginRight: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
    },
    searchLoader: {
        marginLeft: 8,
    },
    searchResults: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
        maxHeight: 300,
    },
    searchResultItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
    },
    searchResultInfo: {
        flex: 1,
        marginLeft: 12,
    },
    searchResultName: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 2,
    },
    searchResultHandle: {
        fontSize: 14,
    },
    emptySearch: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    emptySearchText: {
        fontSize: 14,
    },
    blockedSection: {
        marginTop: 8,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 12,
        paddingHorizontal: 4,
    },
    loadingContainer: {
        paddingVertical: 40,
        alignItems: 'center',
    },
    emptyContainer: {
        paddingVertical: 60,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        marginTop: 12,
        textAlign: 'center',
    },
    blockedList: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    blockedUserItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    blockedUserInfo: {
        flex: 1,
        marginLeft: 12,
    },
    blockedUserName: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 2,
    },
    blockedUserHandle: {
        fontSize: 14,
    },
    unblockButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
    },
    unblockButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    divider: {
        height: 1,
        marginHorizontal: 16,
    },
});
