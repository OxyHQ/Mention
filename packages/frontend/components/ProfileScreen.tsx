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
import { show as toast } from '@oxyhq/bloom/toast';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth, useFollow } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';
import ReportModal from '@/components/report/ReportModal';
import { AddToListSheet } from '@/components/Lists/AddToListSheet';
import { confirmDialog } from '@/utils/alerts';
import type { FeedType } from '@mention/shared-types';
import { logger } from '@/lib/logger';
import { useSafeBack } from '@/hooks/useSafeBack';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { EmptyState } from '@/components/common/EmptyState';
import { getNormalizedUserHandle } from '@oxyhq/core';

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
const FEED_TYPES: FeedType[] = ['posts', 'replies', 'media', 'likes', 'boosts'];

// Tab indices within TAB_NAMES used by the profile stats navigation
const REPLIES_TAB_INDEX = 1;
const BOOSTS_TAB_INDEX = 5;

// Top-right header action icon metrics (IconButton `variant="icon"` renders a
// 32×32 touch target; the cluster uses NativeWind `gap-1` = 4px). Used to size
// the scrolled name overlay so it never overlaps the icons.
const HEADER_ACTION_ICON_SIZE = 32;
const HEADER_ACTION_ICON_GAP = 4;
const HEADER_OVERLAY_ICON_CLEARANCE = 12;

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
    const avatarUri = design?.avatar;
    const bannerUri =
        design?.coverPhotoEnabled && design?.bannerUrl
            ? design.bannerUrl
            : undefined;
    const minimalistMode = design?.minimalistMode ?? false;
    const profileHandle = useMemo(() => {
        return getNormalizedUserHandle({
            username: profileData?.username || username,
            instance: profileData?.instance,
            isFederated: profileData?.isFederated,
        }) || username;
    }, [profileData?.username, profileData?.instance, profileData?.isFederated, username]);

    // Memoized checks
    const isOwnProfile = useMemo(() => {
        if (isFederated) return false;
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id, isFederated]);

    const { colorName: profileColorName } = useProfileScreenColor({
        username,
        designColor: design?.color,
    });

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
            t('profile.tabs.boosts'),
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
            const path = index === 0 ? `/@${profileHandle}` : `/@${profileHandle}/${tabName}`;
            router.replace(path);
        },
        [username, profileHandle]
    );

    const handlePostsPress = useCallback(() => {
        if (activeTab === 0) {
            scrollToContent(profileContentHeight);
        } else {
            onTabPress(0);
        }
    }, [activeTab, profileContentHeight, onTabPress, scrollToContent]);

    const handleBoostsPress = useCallback(() => {
        if (activeTab === BOOSTS_TAB_INDEX) {
            scrollToContent(profileContentHeight);
        } else {
            onTabPress(BOOSTS_TAB_INDEX);
        }
    }, [activeTab, profileContentHeight, onTabPress, scrollToContent]);

    const handleRepliesPress = useCallback(() => {
        if (activeTab === REPLIES_TAB_INDEX) {
            scrollToContent(profileContentHeight);
        } else {
            onTabPress(REPLIES_TAB_INDEX);
        }
    }, [activeTab, profileContentHeight, onTabPress, scrollToContent]);

    const handleShare = useCallback(async () => {
        if (!profileData) return;

        try {
            const shareUrl = `https://mention.earth/@${profileHandle}`;
            const shareMessage = t('profile.share.message', {
                name: profileData.design.displayName,
                defaultValue: `Check out ${profileData.design.displayName}'s profile on Mention!`,
            });

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: t('profile.share.title', {
                    name: profileData.design.displayName,
                    defaultValue: `${profileData.design.displayName} on Mention`,
                }),
            });
        } catch (error) {
            logger.error('Error sharing profile');
        }
    }, [profileData, profileHandle, t]);

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

        const handleAddToList = () => {
            bottomSheet.setBottomSheetContent(
                <AddToListSheet
                    targetUserId={profileData.id}
                    targetLabel={`@${displayUsername}`}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const MenuContent = () => (
            <View className="py-2 px-4">
                <IconButton variant="icon" onPress={handleAddToList} style={{ width: '100%', paddingVertical: 14 }}>
                    <View className="flex-row items-center w-full" style={{ gap: 14 }}>
                        <Ionicons name="list-outline" size={22} color={theme.colors.text} />
                        <Text className="text-foreground text-base font-medium">
                            {t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' })}
                        </Text>
                    </View>
                </IconButton>
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
        const params = new URLSearchParams({
            userId: profileData.id,
            username: profileData.username,
        });
        router.push(`/ai?${params.toString()}`);
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

    // Header name overlay opacity - shows when scrolled past profile content.
    // Guard against the pre-measurement window: until ProfileContent's onLayout
    // reports a real height, profileContentHeight is 0, which would make the
    // interpolation input range [-20, 20] resolve to ~0.5 at scrollY=0 and paint
    // the overlay (avatar + name) on top of the header icons and profile content.
    // Keep the threshold strictly positive and force opacity 0 until measured.
    const headerNameOpacity = useMemo(() => {
        if (profileContentHeight <= 0) {
            return 0;
        }
        // Reveal a touch later than the exact content height so the overlay only
        // appears once the real name has scrolled out of view.
        const revealStart = Math.max(profileContentHeight - 20, 1);
        return scrollY.interpolate({
            inputRange: [revealStart, profileContentHeight + 20],
            outputRange: [0, 1],
            extrapolate: 'clamp',
        });
    }, [scrollY, profileContentHeight]);

    // Number of action icons rendered in the top-right cluster. Drives the right
    // boundary of the scrolled name overlay so a long display name truncates
    // instead of sliding under the icons.
    const headerActionCount = useMemo(() => {
        let count = 1; // share is always present
        if (!isOwnProfile) count += 3; // subscribe + DM + more
        if (isFederated) count += 1; // open-on-instance
        return count;
    }, [isOwnProfile, isFederated]);

    // Each IconButton is HEADER_ACTION_ICON_SIZE wide with HEADER_ACTION_ICON_GAP
    // between them; the cluster is offset from the right edge by
    // (DEFAULT_PADDING - 8). Reserve that span (plus breathing room) so the
    // overlay never collides with the icons.
    const headerOverlayRight = useMemo(
        () =>
            (LAYOUT.DEFAULT_PADDING - 8) +
            headerActionCount * HEADER_ACTION_ICON_SIZE +
            (headerActionCount - 1) * HEADER_ACTION_ICON_GAP +
            HEADER_OVERLAY_ICON_CLEARANCE,
        [headerActionCount]
    );

    // Dynamic styles
    const themedStyles = useMemo(
        () => ({
            container: { paddingTop: insets.top },
            headerActions: { top: insets.top + 6 },
            headerNameOverlay: { top: insets.top + 6, right: headerOverlayRight },
            scrollView: { marginTop: minimalistMode ? 0 : LAYOUT.HEADER_HEIGHT_NARROWED },
            contentContainer: {
                paddingTop: minimalistMode
                    ? insets.top + 60
                    : LAYOUT.HEADER_HEIGHT_EXPANDED - insets.top,
            },
        }),
        [insets.top, minimalistMode, headerOverlayRight]
    );

    return (
        <>
            {profileData ? (
                <SEO
                    title={t('seo.profile.title', {
                        name: profileData.design.displayName,
                        username,
                        defaultValue: `${profileData.design.displayName} (@${username}) on Mention`,
                    })}
                    description={
                        profileData.bio
                            ? t('seo.profile.description', {
                                name: profileData.design.displayName,
                                bio: profileData.bio,
                                defaultValue: `View ${profileData.design.displayName}'s profile on Mention. ${profileData.bio}`,
                            })
                            : t('seo.profile.description', {
                                name: profileData.design.displayName,
                                bio: '',
                                defaultValue: `View ${profileData.design.displayName}'s profile on Mention.`,
                            })
                    }
                    image={avatarUri || bannerUri}
                    type="profile"
                />
            ) : null}
            <BloomColorScope colorPreset={profileColorName} asChild>
            <View className="flex-1 bg-background" style={[{ overflow: 'visible' }, themedStyles.container]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

                {loading ? (
                    <ProfileSkeleton />
                ) : !profileData ? (
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
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <UserName
                                    name={profileData.design.displayName}
                                    verified={profileData.verified}
                                    style={{ name: { fontSize: 18, fontWeight: 'bold', marginBottom: -3 } }}
                                    unifiedColors={true}
                                />
                                <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                                    {t('profile.postsCount', {
                                        count: profileData.postsCount,
                                        defaultValue: `${profileData.postsCount} posts`,
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
                                        className="absolute left-0 right-0 overflow-hidden bg-background"
                                        style={{
                                            height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
                                            top: 0,
                                            zIndex: 1,
                                            pointerEvents: 'none',
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
                                        className="bg-background"
                                        style={[
                                            StyleSheet.absoluteFill,
                                            {
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
                                    onBoostsPress={handleBoostsPress}
                                    onRepliesPress={handleRepliesPress}
                                    onLayout={setProfileContentHeight}
                                />
                                {!isOwnProfile && (
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
                        />

                    </>
                )}
            </View>
            </BloomColorScope>
        </>
    );
};


export default MentionProfile;
