import React, { useMemo, useCallback, useState, useEffect, useContext, useRef } from 'react';
import {
    Animated,
    ImageBackground,
    Linking,
    StatusBar,
    StyleSheet,
    Text,
    View,
    Share,
    Platform,
} from 'react-native';
import { toast } from 'sonner';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth, useFollow } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';
import ReportModal from '@/components/report/ReportModal';
import { confirmDialog } from '@/utils/alerts';
import type { FeedType } from '@mention/shared-types';

// Icons
import { Search } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';

// Components
import { Avatar } from '@oxyhq/bloom/avatar';
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
import { SuggestedUsers } from './suggestions/SuggestedUsers';

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

    // Parse username from URL — strip leading @ but keep user@instance for federated
    let { username: urlUsername } = useLocalSearchParams<{ username: string }>();
    if (urlUsername?.startsWith('@')) {
        urlUsername = urlUsername.slice(1);
    }
    const username = urlUsername || '';
    const isFederated = username.includes('@');

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

    // Follow data — skip useFollow for federated profiles (uses data from profileData)
    const stableUserId = isFederated ? '' : (profileData?.id || '');
    const { followerCount: localFollowerCount = 0, followingCount: localFollowingCount = 0, isFollowing: isFollowingProfileUser = false } = useFollow(stableUserId);
    const followerCount = isFederated ? (profileData?.followersCount ?? 0) : localFollowerCount;
    const followingCount = isFederated ? (profileData?.followingCount ?? 0) : localFollowingCount;

    // Track "just followed" — show suggestions only on the follow action, not on revisits
    const [justFollowed, setJustFollowed] = useState(false);
    const followSettledRef = useRef(false);
    const prevFollowRef = useRef(isFollowingProfileUser);

    // Reset transition tracking when navigating to a different profile
    useEffect(() => {
        followSettledRef.current = false;
        prevFollowRef.current = false;
        setJustFollowed(false);
    }, [stableUserId]);

    useEffect(() => {
        // Skip the initial store hydration (false → true on page load)
        if (!followSettledRef.current) {
            followSettledRef.current = true;
            return;
        }
        // Detect user-initiated follow
        if (isFollowingProfileUser && !prevFollowRef.current) {
            setJustFollowed(true);
        } else if (!isFollowingProfileUser && justFollowed) {
            setJustFollowed(false);
        }
        prevFollowRef.current = isFollowingProfileUser;
    }, [isFollowingProfileUser]);

    // Subscription handling — disabled for federated profiles
    const { subscribed, loading: subLoading, toggle: toggleSubscription } = useSubscription(
        isFederated ? undefined : profileData?.id,
        currentUser?.id,
        isFederated || currentUser?.id === profileData?.id
    );

    // Computed values
    const design = profileData?.design;
    const displayName = design?.displayName || '';
    const avatarUri = design?.avatar;
    const bannerUri =
        design?.coverPhotoEnabled && design?.coverImage
            ? (isFederated ? design.coverImage : oxyServices.getFileDownloadUrl(design.coverImage, 'full'))
            : undefined;
    const minimalistMode = design?.minimalistMode ?? false;

    // Use the visited user's primary color for profile accent when viewing someone else's profile
    const accentColor = (!isOwnProfile && design?.primaryColor) || theme.colors.primary;

    // Memoized checks
    const isOwnProfile = useMemo(() => {
        if (isFederated) return false;
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id, isFederated]);

    const isPrivate = useMemo(
        () => isProfilePrivate(profileData, profileData?.privacy),
        [profileData]
    );

    // Tabs — federated profiles only show Posts
    const tabs = useMemo(
        () => isFederated
            ? [t('profile.tabs.posts')]
            : [
                t('profile.tabs.posts'),
                t('profile.tabs.replies'),
                t('profile.tabs.media'),
                t('profile.tabs.videos'),
                t('profile.tabs.likes'),
                t('profile.tabs.reposts'),
                t('profile.tabs.feeds', { defaultValue: 'Feeds' }),
                t('profile.tabs.starter_packs', { defaultValue: 'Starter Packs' }),
                t('profile.tabs.lists', { defaultValue: 'Lists' }),
            ],
        [t, isFederated]
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
            // Federated profiles only have 1 tab
            if (isFederated) return;
            const tabName = TAB_NAMES[index];
            const path = index === 0 ? `/@${username}` : `/@${username}/${tabName}`;
            router.push(path as any);
        },
        [username, isFederated]
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
                toast.success(t('profile.muted', { username: displayUsername, defaultValue: `@${displayUsername} has been muted` }));
            } else {
                toast.error(t('profile.muteFailed', { defaultValue: 'Failed to mute user' }));
            }
        };

        const handleBlock = async () => {
            bottomSheet.openBottomSheet(false);
            const confirmed = await confirmDialog({
                title: t('profile.blockUser', { defaultValue: `Block @${displayUsername}` }),
                message: t('profile.blockConfirm', { username: displayUsername, defaultValue: `They won't be able to find your profile, posts, or mentions. They won't be notified that you blocked them.` }),
                okText: t('profile.block', { defaultValue: 'Block' }),
                cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
                destructive: true,
            });
            if (!confirmed) return;
            try {
                await oxyServices.blockUser(profileData.id);
                toast.success(t('profile.blocked', { username: displayUsername, defaultValue: `@${displayUsername} has been blocked` }));
            } catch {
                toast.error(t('profile.blockFailed', { defaultValue: 'Failed to block user' }));
            }
        };

        const handleReport = () => {
            bottomSheet.setBottomSheetContent(
                <ReportModal
                    visible={true}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                    onSubmit={async (categories, details) => {
                        const success = await reportService.reportUser(profileData.id, categories, details);
                        if (success) {
                            toast.success(t('report.thankYou', { defaultValue: 'Thank you for helping keep our community safe.' }));
                        } else {
                            toast.error(t('report.failed', { defaultValue: 'Failed to submit report.' }));
                        }
                    }}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const MenuContent = () => (
            <View className="py-2 px-4">
                <IconButton variant="icon" onPress={handleMute} style={{ width: '100%', paddingVertical: 14 }}>
                    <View className="flex-row items-center w-full" style={{ gap: 14 }}>
                        <Ionicons name="volume-mute-outline" size={22} color={theme.colors.text} />
                        <Text className="text-foreground text-base font-medium">
                            {t('profile.muteUser', { username: displayUsername, defaultValue: `Mute @${displayUsername}` })}
                        </Text>
                    </View>
                </IconButton>
                <IconButton variant="icon" onPress={handleBlock} style={{ width: '100%', paddingVertical: 14 }}>
                    <View className="flex-row items-center w-full" style={{ gap: 14 }}>
                        <Ionicons name="ban-outline" size={22} color={theme.colors.error} />
                        <Text className="text-destructive text-base font-medium">
                            {t('profile.blockUser', { username: displayUsername, defaultValue: `Block @${displayUsername}` })}
                        </Text>
                    </View>
                </IconButton>
                <IconButton variant="icon" onPress={handleReport} style={{ width: '100%', paddingVertical: 14 }}>
                    <View className="flex-row items-center w-full" style={{ gap: 14 }}>
                        <Ionicons name="flag-outline" size={22} color={theme.colors.error} />
                        <Text className="text-destructive text-base font-medium">
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
        router.push(`/ai?userId=${profileData.id}&username=${profileData.username}` as any);
    }, [profileData?.id, profileData?.username]);

    // Open on remote instance (federated only)
    const handleOpenOnInstance = useCallback(() => {
        if (profileData?.actorUri) Linking.openURL(profileData.actorUri);
    }, [profileData?.actorUri]);

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
            container: { paddingTop: insets.top },
            headerActions: { top: insets.top + 6 },
            headerNameOverlay: { top: insets.top + 6 },
            scrollView: { marginTop: minimalistMode ? 0 : LAYOUT.HEADER_HEIGHT_NARROWED },
            contentContainer: {
                paddingTop: minimalistMode
                    ? insets.top + 60
                    : LAYOUT.HEADER_HEIGHT_EXPANDED - insets.top,
            },
        }),
        [insets.top, minimalistMode]
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
            <View className="flex-1 bg-background" style={[{ overflow: 'visible' }, themedStyles.container]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

                {loading ? (
                    <ProfileSkeleton />
                ) : (
                    <>
                        {/* Header actions */}
                        <View className="absolute flex-row items-center" style={[{ zIndex: 10, right: LAYOUT.DEFAULT_PADDING, gap: 8 }, themedStyles.headerActions]}>
                            {!isOwnProfile && !isFederated && (
                                <IconButton variant="icon" onPress={toggleSubscription} disabled={subLoading}>
                                    {subscribed ? (
                                        <BellActive size={20} className="text-primary" />
                                    ) : (
                                        <Bell size={20} className="text-foreground" />
                                    )}
                                </IconButton>
                            )}
                            {!isOwnProfile && !isFederated && (
                                <IconButton variant="icon" onPress={handleDM}>
                                    <Ionicons name="mail-outline" size={20} color={theme.colors.text} />
                                </IconButton>
                            )}
                            {isFederated && (
                                <IconButton variant="icon" onPress={handleOpenOnInstance}>
                                    <Ionicons name="open-outline" size={20} color={theme.colors.text} />
                                </IconButton>
                            )}
                            <IconButton variant="icon" onPress={handleShare}>
                                <ShareIcon size={20} className="text-foreground" />
                            </IconButton>
                            {!isOwnProfile && !isFederated && (
                                <IconButton variant="icon" onPress={handleMoreOptions}>
                                    <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.text} />
                                </IconButton>
                            )}
                        </View>

                        {/* Header name overlay (animated on scroll) */}
                        <Animated.View
                            style={[
                                { zIndex: 10, position: 'absolute', left: LAYOUT.DEFAULT_PADDING, flexDirection: 'row', alignItems: 'center', gap: 10 },
                                themedStyles.headerNameOverlay,
                                { opacity: headerNameOpacity },
                                { pointerEvents: 'none' },
                            ]}
                        >
                            <Avatar
                                source={avatarUri}
                                size={32}
                            />
                            <View>
                                <UserName
                                    name={displayName}
                                    verified={profileData?.verified}
                                    style={{ name: { fontSize: 18, fontWeight: 'bold', marginBottom: -3, color: theme.colors.text } }}
                                    unifiedColors={true}
                                />
                                <Text className="text-muted-foreground text-[13px]">
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
                                        className="absolute left-0 right-0 overflow-hidden"
                                        style={{ height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED }}
                                    />
                                    <Animated.View
                                        className="absolute left-0 right-0 overflow-hidden"
                                        style={{
                                            height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
                                            top: 0,
                                            zIndex: 1,
                                            pointerEvents: 'none',
                                            backgroundColor: theme.colors.background,
                                            opacity: headerBackgroundOpacity,
                                        }}
                                    />
                                </>
                            ) : (
                                <View
                                    className="absolute left-0 right-0 overflow-hidden"
                                    style={{
                                        height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
                                        backgroundColor: `${accentColor}20`,
                                    }}
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
                            style={[{ zIndex: 3 }, themedStyles.scrollView]}
                            contentContainerStyle={themedStyles.contentContainer}
                            stickyHeaderIndices={[1]}
                            nestedScrollEnabled={false}
                            removeClippedSubviews={Platform.OS !== 'web'}
                            disableIntervalMomentum={true}
                            decelerationRate="normal"
                            {...(Platform.OS === 'web' ? { 'data-layoutscroll': 'true' } : {})}
                        >
                            {/* Profile info + suggestions wrapper (keeps stickyHeaderIndices stable) */}
                            <View>
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
                                        accentColor={accentColor}
                                        FollowButtonComponent={FollowButtonComponent}
                                        showBottomSheet={showBottomSheet}
                                        onPostsPress={handlePostsPress}
                                        onLayout={setProfileContentHeight}
                                    />
                                )}
                                {!isOwnProfile && !isFederated && profileData?.id && (
                                    <SuggestedUsers
                                        visible={justFollowed}
                                        sourceUserId={profileData.id}
                                    />
                                )}
                            </View>

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
                                isFederated={isFederated}
                                actorUri={profileData?.actorUri}
                            />
                        </Animated.ScrollView>

                        {/* FAB */}
                        <FAB
                            onPress={() => router.push('/compose')}
                            customIcon={<ComposeIcon size={20} className="text-primary-foreground" />}
                        />
                    </>
                )}
            </View>
        </>
    );
};


export default MentionProfile;
