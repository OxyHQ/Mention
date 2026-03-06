import React, { useMemo, useCallback, useState, useEffect, useContext } from 'react';
import {
    Animated,
    ImageBackground,
    StatusBar,
    StyleSheet,
    Text,
    View,
    Share,
    Platform,
    Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useAuth, useFollow } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';
import ReportModal from '@/components/report/ReportModal';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import type { FeedType } from '@mention/shared-types';

// Icons
import { Search } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';

// Components
import Avatar from './Avatar';
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/Button';
import SEO from '@/components/SEO';

// Profile components
import {
    ProfileSkeleton,
    ProfileContent,
    ProfileTabs,
    useSubscription,
    useProfileScroll,
    LAYOUT,
    TAB_NAMES,
    type ProfileScreenProps,
    type ProfileTab,
    type FollowButtonComponent,
} from './Profile';

// Helper functions
const isProfilePrivate = (
    profileData: ProfileData | null,
    privacySettings?: ProfileData['privacy']
): boolean => {
    if (!profileData) return false;
    const privacy = profileData.privacy || privacySettings;
    return Boolean(
        privacy?.profileVisibility === 'private' ||
        privacy?.profileVisibility === 'followers_only'
    );
};

const tabToIndex = (tabName: string): number => {
    const index = TAB_NAMES.indexOf(tabName as ProfileTab);
    return index >= 0 ? index : 0;
};

// Feed types for clearing cache
const FEED_TYPES: FeedType[] = ['posts', 'replies', 'media', 'likes', 'reposts'];

/**
 * Profile Screen - Main orchestrator component
 * Follows industry best practices with clean separation of concerns
 */
const MentionProfile: React.FC<ProfileScreenProps> = ({ tab = 'posts' }) => {
    const { user: currentUser, oxyServices, showBottomSheet } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const bottomSheet = useContext(BottomSheetContext);

    // Component references
    const FollowButtonComponent = (OxyServicesNS as { FollowButton?: FollowButtonComponent })
        .FollowButton as FollowButtonComponent;

    // Parse username from URL
    let { username: urlUsername } = useLocalSearchParams<{ username: string }>();
    if (urlUsername?.startsWith('@')) {
        urlUsername = urlUsername.slice(1);
    }
    const username = urlUsername || '';

    // Active tab index
    const activeTab = useMemo(() => tabToIndex(tab), [tab]);

    // Profile data
    const { data: profileData, loading } = useProfileData(username);

    // Profile content height for scroll-to functionality
    const [profileContentHeight, setProfileContentHeight] = useState(0);

    // Scroll handling
    const { scrollY, onScroll, assignScrollRef, scrollToContent } = useProfileScroll({
        profileId: profileData?.id,
        currentTab: tab,
    });

    // Follow data
    const stableUserId = profileData?.id || '';
    const { followerCount = 0, followingCount = 0 } = useFollow(stableUserId);

    // Subscription handling
    const { subscribed, loading: subLoading, toggle: toggleSubscription } = useSubscription(
        profileData?.id,
        currentUser?.id,
        currentUser?.id === profileData?.id
    );

    // Computed values
    const design = profileData?.design;
    const displayName = design?.displayName || '';
    const avatarUri = design?.avatar;
    const bannerUri =
        design?.coverPhotoEnabled && design?.coverImage
            ? oxyServices.getFileDownloadUrl(design.coverImage, 'full')
            : undefined;
    const minimalistMode = design?.minimalistMode ?? false;

    // Memoized checks
    const isOwnProfile = useMemo(() => {
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id]);

    const isPrivate = useMemo(
        () => isProfilePrivate(profileData, profileData?.privacy),
        [profileData]
    );

    // Tabs
    const tabs = useMemo(
        () => [
            t('profile.tabs.posts'),
            t('profile.tabs.replies'),
            t('profile.tabs.media'),
            t('profile.tabs.videos'),
            t('profile.tabs.likes'),
            t('profile.tabs.reposts'),
        ],
        [t]
    );

    // Clear cached feed data for private profiles
    useEffect(() => {
        if (isPrivate && !isOwnProfile && profileData?.id) {
            const { clearUserFeed } = usePostsStore.getState();
            FEED_TYPES.forEach((type) => {
                clearUserFeed(profileData.id, type);
            });
        }
    }, [isPrivate, isOwnProfile, profileData?.id]);

    // Handlers
    const onTabPress = useCallback(
        (index: number) => {
            if (!username) return;
            const tabName = TAB_NAMES[index];
            const path = index === 0 ? `/@${username}` : `/@${username}/${tabName}`;
            router.push(path as any);
        },
        [username]
    );

    const handlePostsPress = useCallback(() => {
        if (activeTab === 0) {
            scrollToContent(profileContentHeight);
        } else {
            onTabPress(0);
        }
    }, [activeTab, profileContentHeight, onTabPress, scrollToContent]);

    const handleShare = useCallback(async () => {
        if (!profileData) return;

        try {
            const shareUrl = `https://mention.earth/@${profileData.username}`;
            const shareMessage = t('profile.share.message', {
                name: displayName || profileData.username,
                defaultValue: `Check out ${displayName || profileData.username}'s profile on Mention!`,
            });

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: t('profile.share.title', {
                    name: displayName || profileData.username,
                    defaultValue: `${displayName || profileData.username} on Mention`,
                }),
            });
        } catch (error) {
            console.error('Error sharing profile:', error);
        }
    }, [profileData, displayName, t]);

    // More options menu (block, mute, report)
    const handleMoreOptions = useCallback(() => {
        if (!profileData || isOwnProfile) return;

        const displayUsername = profileData.username;

        const handleMute = async () => {
            bottomSheet.openBottomSheet(false);
            const success = await muteService.muteUser(profileData.id);
            if (success) {
                Alert.alert(t('common.success', { defaultValue: 'Success' }), t('profile.muted', { username: displayUsername, defaultValue: `@${displayUsername} has been muted` }));
            } else {
                Alert.alert(t('common.error', { defaultValue: 'Error' }), t('profile.muteFailed', { defaultValue: 'Failed to mute user' }));
            }
        };

        const handleBlock = () => {
            bottomSheet.setBottomSheetContent(
                <ConfirmBottomSheet
                    title={t('profile.blockUser', { defaultValue: `Block @${displayUsername}` })}
                    message={t('profile.blockConfirm', { username: displayUsername, defaultValue: `They won't be able to find your profile, posts, or mentions. They won't be notified that you blocked them.` })}
                    confirmText={t('profile.block', { defaultValue: 'Block' })}
                    cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
                    destructive={true}
                    onConfirm={async () => {
                        try {
                            await oxyServices.blockUser(profileData.id);
                            bottomSheet.openBottomSheet(false);
                            Alert.alert(t('common.success', { defaultValue: 'Success' }), t('profile.blocked', { username: displayUsername, defaultValue: `@${displayUsername} has been blocked` }));
                        } catch {
                            bottomSheet.openBottomSheet(false);
                            Alert.alert(t('common.error', { defaultValue: 'Error' }), t('profile.blockFailed', { defaultValue: 'Failed to block user' }));
                        }
                    }}
                    onCancel={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const handleReport = () => {
            bottomSheet.setBottomSheetContent(
                <ReportModal
                    visible={true}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                    onSubmit={async (categories, details) => {
                        const success = await reportService.reportUser(profileData.id, categories, details);
                        if (success) {
                            Alert.alert(t('report.submitted', { defaultValue: 'Report Submitted' }), t('report.thankYou', { defaultValue: 'Thank you for helping keep our community safe.' }));
                        } else {
                            Alert.alert(t('common.error', { defaultValue: 'Error' }), t('report.failed', { defaultValue: 'Failed to submit report.' }));
                        }
                    }}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const MenuContent = () => (
            <View style={styles.menuContainer}>
                <IconButton variant="icon" onPress={handleMute} style={styles.menuItem}>
                    <View style={styles.menuItemRow}>
                        <Ionicons name="volume-mute-outline" size={22} color={theme.colors.text} />
                        <Text style={[styles.menuItemText, { color: theme.colors.text }]}>
                            {t('profile.muteUser', { username: displayUsername, defaultValue: `Mute @${displayUsername}` })}
                        </Text>
                    </View>
                </IconButton>
                <IconButton variant="icon" onPress={handleBlock} style={styles.menuItem}>
                    <View style={styles.menuItemRow}>
                        <Ionicons name="ban-outline" size={22} color={theme.colors.error} />
                        <Text style={[styles.menuItemText, { color: theme.colors.error }]}>
                            {t('profile.blockUser', { username: displayUsername, defaultValue: `Block @${displayUsername}` })}
                        </Text>
                    </View>
                </IconButton>
                <IconButton variant="icon" onPress={handleReport} style={styles.menuItem}>
                    <View style={styles.menuItemRow}>
                        <Ionicons name="flag-outline" size={22} color={theme.colors.error} />
                        <Text style={[styles.menuItemText, { color: theme.colors.error }]}>
                            {t('profile.reportUser', { defaultValue: 'Report' })}
                        </Text>
                    </View>
                </IconButton>
            </View>
        );

        bottomSheet.setBottomSheetContent(<MenuContent />);
        bottomSheet.openBottomSheet(true);
    }, [profileData, isOwnProfile, theme, t, bottomSheet, oxyServices]);

    // DM button handler
    const handleDM = useCallback(() => {
        if (!profileData?.id) return;
        // Navigate to DM conversation with this user
        router.push(`/kaana?userId=${profileData.id}&username=${profileData.username}` as any);
    }, [profileData?.id, profileData?.username]);

    // Animations
    const headerBackgroundOpacity = useMemo(
        () =>
            scrollY.interpolate({
                inputRange: [0, LAYOUT.HEADER_HEIGHT_EXPANDED],
                outputRange: [0, 1],
                extrapolate: 'clamp',
            }),
        [scrollY]
    );

    // Header name overlay opacity - shows when scrolled past profile content
    const headerNameOpacity = useMemo(
        () =>
            scrollY.interpolate({
                inputRange: [profileContentHeight - 20, profileContentHeight + 20],
                outputRange: [0, 1],
                extrapolate: 'clamp',
            }),
        [scrollY, profileContentHeight]
    );

    // SEO data
    const profileDisplayName = displayName || profileData?.username || username;
    const profileBio = profileData?.bio || '';
    const profileImage = avatarUri || bannerUri;

    // Dynamic styles
    const themedStyles = useMemo(
        () => ({
            container: { paddingTop: insets.top, backgroundColor: theme.colors.background },
            headerActions: { top: insets.top + 6 },
            headerNameOverlay: { top: insets.top + 6 },
            scrollView: { marginTop: minimalistMode ? 0 : LAYOUT.HEADER_HEIGHT_NARROWED },
            contentContainer: {
                paddingTop: minimalistMode
                    ? insets.top + 60
                    : LAYOUT.HEADER_HEIGHT_EXPANDED - insets.top,
            },
            fabStyle: {
                position: 'absolute' as const,
                bottom: LAYOUT.FAB_BOTTOM_MARGIN + insets.bottom,
                right: LAYOUT.FAB_RIGHT_MARGIN,
                zIndex: 1000,
            },
        }),
        [insets.top, insets.bottom, minimalistMode, theme.colors.background]
    );

    return (
        <>
            <SEO
                title={t('seo.profile.title', {
                    name: profileDisplayName,
                    username: username,
                    defaultValue: `${profileDisplayName} (@${username}) on Mention`,
                })}
                description={
                    profileBio
                        ? t('seo.profile.description', {
                            name: profileDisplayName,
                            bio: profileBio,
                            defaultValue: `View ${profileDisplayName}'s profile on Mention. ${profileBio}`,
                        })
                        : t('seo.profile.description', {
                            name: profileDisplayName,
                            bio: '',
                            defaultValue: `View ${profileDisplayName}'s profile on Mention.`,
                        })
                }
                image={profileImage}
                type="profile"
            />
            <View style={[styles.container, themedStyles.container]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

                {loading ? (
                    <ProfileSkeleton />
                ) : (
                    <>
                        {/* Header actions */}
                        <View style={[styles.headerActions, themedStyles.headerActions]}>
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={toggleSubscription} disabled={subLoading}>
                                    {subscribed ? (
                                        <BellActive size={20} color={theme.colors.primary} />
                                    ) : (
                                        <Bell size={20} color={theme.colors.text} />
                                    )}
                                </IconButton>
                            )}
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={handleDM}>
                                    <Ionicons name="mail-outline" size={20} color={theme.colors.text} />
                                </IconButton>
                            )}
                            <IconButton variant="icon" onPress={handleShare}>
                                <ShareIcon size={20} color={theme.colors.text} />
                            </IconButton>
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={handleMoreOptions}>
                                    <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.text} />
                                </IconButton>
                            )}
                        </View>

                        {/* Header name overlay (animated on scroll) */}
                        <Animated.View
                            style={[
                                styles.headerNameOverlay,
                                themedStyles.headerNameOverlay,
                                { opacity: headerNameOpacity },
                            ]}
                            pointerEvents="none"
                        >
                            <Avatar
                                source={avatarUri}
                                size={32}
                            />
                            <View>
                                <UserName
                                    name={displayName}
                                    verified={profileData?.verified}
                                    style={{ name: { ...styles.headerTitle, color: theme.colors.text } }}
                                    unifiedColors={true}
                                />
                                <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
                                    {t('profile.postsCount', {
                                        count: profileData?.postsCount ?? 0,
                                        defaultValue: `${profileData?.postsCount ?? 0} posts`,
                                    })}
                                </Text>
                            </View>
                        </Animated.View>

                        {/* Banner */}
                        {!minimalistMode &&
                            (bannerUri ? (
                                <>
                                    <ImageBackground
                                        source={{ uri: bannerUri }}
                                        style={[styles.banner, styles.bannerHeight]}
                                    />
                                    <Animated.View
                                        style={[
                                            styles.banner,
                                            styles.bannerHeight,
                                            styles.bannerOverlay,
                                            { pointerEvents: 'none' },
                                            {
                                                backgroundColor: theme.colors.background,
                                                opacity: headerBackgroundOpacity,
                                            },
                                        ]}
                                    />
                                </>
                            ) : (
                                <View
                                    style={[
                                        styles.banner,
                                        styles.bannerHeight,
                                        { backgroundColor: `${theme.colors.primary}20` },
                                    ]}
                                >
                                    <Animated.View
                                        style={[
                                            StyleSheet.absoluteFillObject,
                                            {
                                                backgroundColor: theme.colors.background,
                                                opacity: headerBackgroundOpacity,
                                            },
                                        ]}
                                    />
                                </View>
                            ))}

                        {/* Main scroll content */}
                        <Animated.ScrollView
                            ref={assignScrollRef}
                            showsVerticalScrollIndicator={false}
                            onScroll={onScroll}
                            scrollEventThrottle={16}
                            style={[styles.scrollView, themedStyles.scrollView]}
                            contentContainerStyle={themedStyles.contentContainer}
                            stickyHeaderIndices={[1]}
                            nestedScrollEnabled={false}
                            removeClippedSubviews={Platform.OS !== 'web'}
                            disableIntervalMomentum={true}
                            decelerationRate="normal"
                            {...(Platform.OS === 'web' ? { 'data-layoutscroll': 'true' } : {})}
                        >
                            {/* Profile info */}
                            {profileData && (
                                <ProfileContent
                                    profileData={profileData}
                                    avatarUri={avatarUri}
                                    isOwnProfile={isOwnProfile}
                                    isPrivate={isPrivate}
                                    currentUsername={currentUser?.username}
                                    followingCount={followingCount}
                                    followerCount={followerCount}
                                    username={username}
                                    FollowButtonComponent={FollowButtonComponent}
                                    showBottomSheet={showBottomSheet}
                                    onPostsPress={handlePostsPress}
                                    onLayout={setProfileContentHeight}
                                />
                            )}

                            {/* Tabs */}
                            <AnimatedTabBar
                                tabs={tabs.map((tabLabel, i) => ({ id: String(i), label: tabLabel }))}
                                activeTabId={String(activeTab)}
                                onTabPress={(id) => onTabPress(parseInt(id))}
                                scrollEnabled={true}
                                instanceId={username || 'default'}
                            />

                            {/* Tab content */}
                            <ProfileTabs
                                tab={tab}
                                profileId={profileData?.id}
                                isPrivate={isPrivate}
                                isOwnProfile={isOwnProfile}
                            />
                        </Animated.ScrollView>

                        {/* FAB */}
                        <FAB
                            onPress={() => router.push('/compose')}
                            icon="create-outline"
                            style={themedStyles.fabStyle}
                        />
                    </>
                )}
            </View>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        overflow: 'visible',
    },
    headerActions: {
        zIndex: 10,
        position: 'absolute',
        right: LAYOUT.DEFAULT_PADDING,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerNameOverlay: {
        zIndex: 10,
        position: 'absolute',
        left: LAYOUT.DEFAULT_PADDING,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    headerAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: -3,
    },
    headerSubtitle: {
        fontSize: 13,
    },
    banner: {
        position: 'absolute',
        left: 0,
        right: 0,
        overflow: 'hidden',
    },
    bannerHeight: {
        height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
    },
    bannerOverlay: {
        top: 0,
        zIndex: 1,
    },
    scrollView: {
        zIndex: 3,
    },
    menuContainer: {
        paddingVertical: 8,
        paddingHorizontal: 16,
    },
    menuItem: {
        width: '100%',
        paddingVertical: 14,
    },
    menuItemRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        width: '100%',
    },
    menuItemText: {
        fontSize: 16,
        fontWeight: '500',
    },
});

export default MentionProfile;
