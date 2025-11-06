import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { searchService } from '@/services/searchService';
import { oxyServices } from '@/lib/oxyServices';
import Avatar from '@/components/Avatar';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useOxy } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import MessageBottomSheet from '@/components/common/MessageBottomSheet';

const IconComponent = Ionicons as any;

interface RestrictedUser {
    id: string;
    name?: string | { full?: string; first?: string; last?: string };
    username?: string;
    handle?: string;
    avatar?: string;
}

export default function RestrictedUsersScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const { user: currentUser, isAuthenticated } = useOxy();
    const bottomSheet = React.useContext(BottomSheetContext);
    const [restrictedUserIds, setRestrictedUserIds] = useState<string[]>([]);
    const [restrictedUsers, setRestrictedUsers] = useState<RestrictedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<RestrictedUser[]>([]);
    const [searching, setSearching] = useState(false);
    const [restricting, setRestricting] = useState<string | null>(null);

    const loadRestrictedUsers = useCallback(async () => {
        if (!isAuthenticated) {
            console.log('[RestrictedUsers] Not authenticated, skipping load');
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            console.log('[RestrictedUsers] Loading restricted users...');
            const response = await authenticatedClient.get('/profile/restricts');
            console.log('[RestrictedUsers] API response:', response.data);
            let userIds = response.data?.restrictedUsers || [];
            
            // Filter out the current user's ID (can't restrict yourself)
            const currentUserId = currentUser?.id;
            if (currentUserId) {
                userIds = userIds.filter((id: string) => id !== currentUserId);
            }
            
            console.log('[RestrictedUsers] Restricted user IDs (filtered):', userIds);
            setRestrictedUserIds(userIds);

            if (userIds.length === 0) {
                setRestrictedUsers([]);
                setLoading(false);
                return;
            }

            // Fetch user details for each restricted user
            const userPromises = userIds.map(async (userId: string) => {
                try {
                    console.log(`[RestrictedUsers] Fetching user details for: ${userId}`);
                    
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
                                console.log(`[RestrictedUsers] getProfileById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getProfile === 'function') {
                            try {
                                return await svc.getProfile(id);
                            } catch (e) {
                                console.log(`[RestrictedUsers] getProfile failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUserById === 'function') {
                            try {
                                return await svc.getUserById(id);
                            } catch (e) {
                                console.log(`[RestrictedUsers] getUserById failed for ${id}`);
                            }
                        }
                        if (typeof svc.getUser === 'function') {
                            try {
                                return await svc.getUser(id);
                            } catch (e) {
                                console.log(`[RestrictedUsers] getUser failed for ${id}`);
                            }
                        }
                        return null;
                    };
                    
                    const user = await usersState.ensureById(String(userId), loader);
                    console.log(`[RestrictedUsers] Found user for ${userId}:`, user ? 'yes' : 'no', user);
                    
                    // If we couldn't fetch user details, create a minimal user object
                    if (!user) {
                        console.log(`[RestrictedUsers] Creating fallback user object for ${userId}`);
                        return {
                            id: userId,
                            username: userId.substring(0, 8) + '...',
                            handle: userId.substring(0, 8) + '...',
                        } as RestrictedUser;
                    }
                    
                    return user;
                } catch (error) {
                    console.warn(`[RestrictedUsers] Failed to fetch user ${userId}:`, error);
                    // Return fallback user object instead of null
                    return {
                        id: userId,
                        username: userId.substring(0, 8) + '...',
                        handle: userId.substring(0, 8) + '...',
                    } as RestrictedUser;
                }
            });

            const users = (await Promise.all(userPromises)).filter(Boolean) as RestrictedUser[];
            console.log('[RestrictedUsers] Loaded users:', users.length);
            setRestrictedUsers(users);
        } catch (error: any) {
            console.error('[RestrictedUsers] Error loading restricted users:', error);
            console.error('[RestrictedUsers] Error response:', error.response?.data);
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
    }, [t, currentUser?.id, isAuthenticated, bottomSheet]);

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

    const handleSearch = async (query: string) => {
        setSearchQuery(query);
        if (!query.trim()) {
            setSearchResults([]);
            return;
        }

        try {
            setSearching(true);
            const results = await searchService.searchUsers(query);
            // Filter out already restricted users
            const filtered = results.filter((user: any) => {
                const userId = user.id || user._id;
                return userId && !restrictedUserIds.includes(userId);
            });
            setSearchResults(filtered);
        } catch (error) {
            console.error('Error searching users:', error);
        } finally {
            setSearching(false);
        }
    };

    const handleRestrict = async (user: RestrictedUser) => {
        const userId = user.id || (user as any)._id;
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
            setSearchResults(prev => prev.filter(u => {
                const id = u.id || (u as any)._id;
                return id !== userId;
            }));
            const restrictResponse = await authenticatedClient.post('/profile/restricts', {
                restrictedId: userId
            });
            console.log('[RestrictedUsers] Restrict response:', restrictResponse.data);
            
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
        } catch (error: any) {
            console.error('Error restricting user:', error);
            // Revert optimistic update on error
            setRestrictedUserIds(prev => prev.filter(id => id !== userId));
            setRestrictedUsers(prev => prev.filter(u => {
                const id = u.id || (u as any)._id;
                return id !== userId;
            }));
            const errorMessage = error.response?.data?.error || t('settings.privacy.failedToRestrictUser');
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
        const userToRemove = restrictedUsers.find(u => {
            const id = u.id || (u as any)._id;
            return id === userId;
        });

        const performUnrestrict = async () => {
            try {
                console.log('[RestrictedUsers] Unrestricting user:', userId);
                
                // Optimistically remove from list
                setRestrictedUserIds(prev => prev.filter(id => id !== userId));
                setRestrictedUsers(prev => prev.filter(u => {
                    const id = u.id || (u as any)._id;
                    return id !== userId;
                }));
                
                const unrestrictResponse = await authenticatedClient.delete(`/profile/restricts/${userId}`);
                console.log('[RestrictedUsers] Unrestrict response:', unrestrictResponse.data);
                
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
            } catch (error: any) {
                console.error('[RestrictedUsers] Error unrestricting user:', error);
                console.error('[RestrictedUsers] Error response:', error.response?.data);
                // Revert optimistic update on error
                if (userToRemove) {
                    setRestrictedUserIds(prev => [...prev, userId]);
                    setRestrictedUsers(prev => [...prev, userToRemove]);
                }
                const errorMessage = error.response?.data?.error || t('settings.privacy.failedToUnrestrictUser');
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

    const getUserDisplayName = (user: RestrictedUser) => {
        if (typeof user.name === 'string') return user.name;
        if (user.name?.full) return user.name.full;
        if (user.name?.first) return `${user.name.first} ${user.name.last || ''}`.trim();
        return user.username || user.handle || '';
    };

    const getUserHandle = (user: RestrictedUser) => {
        return user.username || user.handle || '';
    };

    const getAvatarUri = (user: RestrictedUser) => {
        if (user.avatar) {
            return oxyServices.getFileDownloadUrl(user.avatar, 'thumb');
        }
        return undefined;
    };

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.restrictedProfiles'),
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
                {/* Info Card */}
                <View style={[styles.infoCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <IconComponent name="information-circle" size={20} color={theme.colors.primary} />
                    <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
                        {t('settings.privacy.restrictedUsersDescription')}
                    </Text>
                </View>

                {/* Search Section */}
                <View style={[styles.searchContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <View style={[styles.searchInputContainer, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
                        <IconComponent name="search" size={20} color={theme.colors.textSecondary} style={styles.searchIcon} />
                        <TextInput
                            style={[styles.searchInput, { color: theme.colors.text }]}
                            placeholder={t('settings.privacy.searchUsersToRestrict')}
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
                        <View style={styles.searchResults}>
                            {searchResults.map((user) => {
                                const userId = user.id || (user as any)._id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);
                                const isRestricting = restricting === userId;

                                return (
                                    <TouchableOpacity
                                        key={userId}
                                        style={[styles.searchResultItem, { borderBottomColor: theme.colors.border }]}
                                        onPress={() => !isRestricting && handleRestrict(user)}
                                        disabled={isRestricting}
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
                                        {isRestricting ? (
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

                {/* Restricted Users List */}
                <View style={styles.restrictedSection}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('settings.privacy.restrictedUsers')}
                    </Text>

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={theme.colors.primary} />
                        </View>
                    ) : restrictedUsers.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <IconComponent name="people-outline" size={48} color={theme.colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.noRestrictedUsers')}
                            </Text>
                        </View>
                    ) : (
                        <View style={[styles.restrictedList, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            {restrictedUsers.map((user, index) => {
                                const userId = user.id || (user as any)._id;
                                const displayName = getUserDisplayName(user);
                                const handle = getUserHandle(user);
                                const avatarUri = getAvatarUri(user);

                                return (
                                    <View key={userId}>
                                        <View style={styles.restrictedUserItem}>
                                            <Avatar
                                                source={avatarUri ? { uri: avatarUri } : undefined}
                                                size={48}
                                                label={displayName?.[0] || handle?.[0]}
                                            />
                                            <View style={styles.restrictedUserInfo}>
                                                <Text style={[styles.restrictedUserName, { color: theme.colors.text }]}>
                                                    {displayName}
                                                </Text>
                                                <Text style={[styles.restrictedUserHandle, { color: theme.colors.textSecondary }]}>
                                                    @{handle}
                                                </Text>
                                            </View>
                                            <TouchableOpacity
                                                style={[styles.unrestrictButton, { backgroundColor: theme.colors.error + '20' }]}
                                                activeOpacity={0.7}
                                                onPress={() => {
                                                    console.log('[RestrictedUsers] Unrestrict button pressed for userId:', userId, 'user:', user);
                                                    if (userId) {
                                                        handleUnrestrict(userId);
                                                    } else {
                                                        console.error('[RestrictedUsers] No userId found for user:', user);
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
                                                <Text style={[styles.unrestrictButtonText, { color: theme.colors.error }]}>
                                                    {t('settings.privacy.unrestrict')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                        {index < restrictedUsers.length - 1 && (
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
    infoCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        borderRadius: 16,
        borderWidth: 1,
        padding: 16,
        marginBottom: 20,
        gap: 12,
    },
    infoText: {
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
    },
    searchContainer: {
        borderRadius: 16,
        borderWidth: 1,
        padding: 16,
        marginBottom: 24,
    },
    searchInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
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
        marginTop: 12,
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
    restrictedSection: {
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
    restrictedList: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    restrictedUserItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    restrictedUserInfo: {
        flex: 1,
        marginLeft: 12,
    },
    restrictedUserName: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 2,
    },
    restrictedUserHandle: {
        fontSize: 14,
    },
    unrestrictButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
    },
    unrestrictButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    divider: {
        height: 1,
        marginHorizontal: 16,
    },
});
