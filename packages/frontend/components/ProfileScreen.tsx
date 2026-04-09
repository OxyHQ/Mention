import React, { useMemo, useCallback, useState, useEffect, useContext, useRef, type ReactNode } from 'react';
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
import { show as toast } from '@oxyhq/bloom/toast';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { APP_COLOR_PRESETS, getScopedColorCSSVariables } from '@/lib/app-color-presets';
import type { AppColorName } from '@oxyhq/bloom/theme';
import { vars } from 'react-native-css';
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
import { logger } from '@/lib/logger';
import { useSafeBack } from '@/hooks/useSafeBack';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { EmptyState } from '@/components/common/EmptyState';
import { useScreenColor } from '@/context/ScreenColorContext';

// Icons
import { Search } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { MailIcon } from '@/assets/icons/mail-icon';
import { MoreIcon } from '@/assets/icons/more-icon';
import { ExternalLinkIcon } from '@/assets/icons/external-link-icon';

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
function ProfileColorScope({ children }: { colorPreset?: AppColorName; children: ReactNode }) {
    return <>{children}</>;
}

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

    // Active tab — use local state so tab switching doesn't trigger router navigation.
    // Initialize from the route prop, then manage locally.
    const [activeTab, setActiveTab] = useState(() => tabToIndex(tab));

    // Profile data
    const { data: profileData, loading, error: profileError } = useProfileData(username);
    const safeBack = useSafeBack();

    // Profile content height for scroll-to functionality
    const [profileContentHeight, setProfileContentHeight] = useState(0);

    // Scroll handling
    const { scrollY, onScroll, assignScrollRef, scrollToContent } = useProfileScroll({
        profileId: profileData?.id,
        currentTab: TAB_NAMES[activeTab] || 'posts',
    });

    // Follow data — federated users are stored in Oxy, so useFollow works with their Oxy ID
    const stableUserId = profileData?.id || '';
    const { followerCount: rawFollowerCount, followingCount: rawFollowingCount, isFollowing: isFollowingProfileUser = false } = useFollow(stableUserId);
    const followerCount = rawFollowerCount ?? 0;
    const followingCount = rawFollowingCount ?? 0;

    // Track "just followed" — show suggestions only on the follow action, not on revisits
    const [justFollowed, setJustFollowed] = useState(false);
    const followSettledRef = useRef(false);
    const prevFollowRef = useRef(isFollowingProfileUser);
    const prevUserIdRef = useRef(stableUserId);

    // Compute follow transition during render instead of chained effects
    if (prevUserIdRef.current !== stableUserId) {
        // Reset tracking when navigating to a different profile
        prevUserIdRef.current = stableUserId;
        followSettledRef.current = false;
        prevFollowRef.current = false;
        if (justFollowed) setJustFollowed(false);
    } else if (!followSettledRef.current) {
        // Skip initial store hydration
        followSettledRef.current = true;
        prevFollowRef.current = isFollowingProfileUser;
    } else if (isFollowingProfileUser !== prevFollowRef.current) {
        // Detect user-initiated follow/unfollow
        if (isFollowingProfileUser) {
            setJustFollowed(true);
        } else if (justFollowed) {
            setJustFollowed(false);
        }
        prevFollowRef.current = isFollowingProfileUser;
    }

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
            ? (isFederated ? design.coverImage : oxyServices.getFileDownloadUrl(design.coverImage, 'full'))
            : undefined;
    const minimalistMode = design?.minimalistMode ?? false;

    // Memoized checks
    const isOwnProfile = useMemo(() => {
        if (isFederated) return false;
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id, isFederated]);

    // Scoped color override: apply visited user's color preset to entire profile subtree
    const { setScreenColor } = useScreenColor();
    const visitedColorName = useMemo<AppColorName | undefined>(() => {
        if (isOwnProfile || !design?.color) return undefined;
        const name = design.color as AppColorName;
        return APP_COLOR_PRESETS[name] ? name : undefined;
    }, [isOwnProfile, design?.color]);
    const visitedColorPreset = visitedColorName ? APP_COLOR_PRESETS[visitedColorName] : undefined;

    // Propagate color to layout so layout-owned elements (SignInBanner, etc.) inherit it
    useEffect(() => {
        const colorName = !isOwnProfile && design?.color ? design.color as keyof typeof APP_COLOR_PRESETS : undefined;
        setScreenColor(colorName && APP_COLOR_PRESETS[colorName] ? colorName : undefined);
        return () => setScreenColor(undefined);
    }, [isOwnProfile, design?.color, setScreenColor]);

    const profileColorVars = useMemo(() => {
        if (!visitedColorPreset) return undefined;
        return vars(getScopedColorCSSVariables(visitedColorPreset, theme.isDark ? 'dark' : 'light'));
    }, [visitedColorPreset, theme.isDark]);

    // Compute explicit background color from the preset so NativeWind bg-background gets overridden
    const profileBgColor = useMemo(() => {
        if (!visitedColorPreset) return undefined;
        const hslValues = (theme.isDark ? visitedColorPreset.dark : visitedColorPreset.light)['--background'];
        return hslValues ? `hsl(${hslValues.replace(/ /g, ', ')})` : undefined;
    }, [visitedColorPreset, theme.isDark]);

    // User's profile color hex for passing to buttons
    const isPrivate = useMemo(
        () => isProfilePrivate(profileData, profileData?.privacy),
        [profileData]
    );

    // Tabs — all users (including federated) get full tabs since data is in Oxy/Mention DB
    const tabs = useMemo(
        () => [
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
            setActiveTab(index);
            // Update URL silently for deep-linking / sharing without triggering navigation
            const tabName = TAB_NAMES[index];
            const path = index === 0 ? `/@${username}` : `/@${username}/${tabName}`;
            router.replace(path as any);
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
            logger.error('Error sharing profile');
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
                toast(t('profile.muted', { username: displayUsername, defaultValue: `@${displayUsername} has been muted` }), { type: 'success' });
            } else {
                toast(t('profile.muteFailed', { defaultValue: 'Failed to mute user' }), { type: 'error' });
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
                toast(t('profile.blocked', { username: displayUsername, defaultValue: `@${displayUsername} has been blocked` }), { type: 'success' });
            } catch {
                toast(t('profile.blockFailed', { defaultValue: 'Failed to block user' }), { type: 'error' });
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
                            toast(t('report.thankYou', { defaultValue: 'Thank you for helping keep our community safe.' }), { type: 'success' });
                        } else {
                            toast(t('report.failed', { defaultValue: 'Failed to submit report.' }), { type: 'error' });
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
            <ProfileColorScope colorPreset={visitedColorName}>
            <View className="flex-1 bg-background" style={[{ overflow: 'visible' }, themedStyles.container, profileColorVars, profileBgColor ? { backgroundColor: profileBgColor } : undefined]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

                {loading ? (
                    <ProfileSkeleton />
                ) : !profileData && profileError ? (
                    <EmptyState
                        customIcon={<NoUpdatesIllustration width={200} height={200} />}
                        title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
                        subtitle={t('profile.notFound.message', { defaultValue: "This profile couldn't be loaded. The user may not exist or their server may be unavailable." })}
                        action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }}
                    />
                ) : (
                    <>
                        {/* Header actions */}
                        <View className="absolute flex-row items-center gap-1" style={[{ zIndex: 10, right: LAYOUT.DEFAULT_PADDING - 8 }, themedStyles.headerActions]}>
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={toggleSubscription} disabled={subLoading}>
                                    {subscribed ? (
                                        <BellActive size={18} className="text-primary" />
                                    ) : (
                                        <Bell size={18} className="text-foreground" />
                                    )}
                                </IconButton>
                            )}
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={handleDM}>
                                    <MailIcon size={18} className="text-foreground" />
                                </IconButton>
                            )}
                            {isFederated && (
                                <IconButton variant="icon" onPress={handleOpenOnInstance}>
                                    <ExternalLinkIcon size={18} className="text-foreground" />
                                </IconButton>
                            )}
                            <IconButton variant="icon" onPress={handleShare}>
                                <ShareIcon size={18} className="text-foreground" />
                            </IconButton>
                            {!isOwnProfile && (
                                <IconButton variant="icon" onPress={handleMoreOptions}>
                                    <MoreIcon size={18} className="text-foreground" />
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
                                    style={{ name: { fontSize: 18, fontWeight: 'bold', marginBottom: -3 } }}
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
                                            backgroundColor: profileBgColor || theme.colors.background,
                                            opacity: headerBackgroundOpacity,
                                        }}
                                    />
                                </>
                            ) : (
                                <View
                                    className="absolute left-0 right-0 overflow-hidden bg-primary/[0.125]"
                                    style={{ height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED }}
                                >
                                    <Animated.View
                                        style={[
                                            StyleSheet.absoluteFillObject,
                                            {
                                                backgroundColor: profileBgColor || theme.colors.background,
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
                            nestedScrollEnabled={true}
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
                                        FollowButtonComponent={FollowButtonComponent}
                                        showBottomSheet={showBottomSheet}
                                        onPostsPress={handlePostsPress}
                                        onLayout={setProfileContentHeight}
                                    />
                                )}
                                {!isOwnProfile && profileData?.id && (
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
                                tab={TAB_NAMES[activeTab] || 'posts'}
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
                            style={visitedColorPreset ? { backgroundColor: visitedColorPreset.hex } : undefined}
                        />

                    </>
                )}
            </View>
            </ProfileColorScope>
        </>
    );
};


export default MentionProfile;
