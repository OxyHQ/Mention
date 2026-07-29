import React, { useMemo, useCallback, useState, useEffect, useContext, useRef } from 'react';
import {
    Animated,
    ImageBackground,
    StatusBar,
    StyleSheet,
    Text,
    View,
    Share,
    Platform,
} from 'react-native';
import { toast } from '@oxyhq/bloom/toast';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BloomColorScope, useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { FollowButton as OxyFollowButton, useAuth, useFollow } from '@oxyhq/services/ui/client';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';
import { showActionMenu } from '@/components/common/ActionMenu';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { ReportModal } from '@/components/report/ReportModal';
import { AddToListSheet } from '@/components/Lists/AddToListSheet';
import { AddToStarterPackSheet } from '@/components/AddToStarterPackSheet';
import { confirmDialog } from '@/utils/alerts';
import { openExternalLink } from '@/utils/openExternalLink';
import type { FeedType } from '@mention/shared-types';
import { logger } from '@/lib/logger';
import { useSafeBack } from '@/hooks/useSafeBack';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { EmptyState } from '@/components/common/EmptyState';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { usePanelStickyTopInset, usePanelStickyTabsTopInset, PANEL_HEADER_HEIGHT } from '@/components/shell/PanelChrome';

// Icons
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { MailIcon } from '@/assets/icons/mail-icon';
import { MoreIcon } from '@/assets/icons/more-icon';
import { ExternalLinkIcon } from '@/assets/icons/external-link-icon';
import { List as ListIcon } from '@/assets/icons/list-icon';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';
import { MuteIcon } from '@/assets/icons/mute-icon';
import { BlockIcon } from '@/assets/icons/block-icon';
import { ReportIcon } from '@/assets/icons/report-icon';

// Components
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
import { IconButton } from '@/components/ui/Button';
import { SEO } from '@/components/SEO';

// Profile components
import {
    ProfileSkeleton,
    ProfileContent,
    ProfileTabs,
    useSubscription,
    useProfileScroll,
    LAYOUT,
    TAB_NAMES,
    shouldFeedOwnProfileScroll,
    shouldGridOwnProfileScroll,
    type ProfileScreenProps,
    type ProfileTab,
} from './Profile';
import { SuggestedUsers } from './suggestions/SuggestedUsers';

const IS_WEB = Platform.OS === 'web';

// Banner image wrapped for the pull-to-zoom parallax (scale driven by the shared
// scrollY). Created once at module scope so it is a stable component type.
const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);

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
interface MentionProfileContentProps extends ProfileScreenProps {
    username: string;
    isFederated: boolean;
    profileData: ProfileData | null;
    loading: boolean;
}

const MentionProfileContent: React.FC<MentionProfileContentProps> = ({
    tab = 'posts',
    username,
    isFederated,
    profileData,
    loading,
}) => {
    const { user: currentUser, oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const bottomSheet = useContext(BottomSheetContext);

    // Web sticky-chrome top insets, resolved from the shared PanelChrome source
    // of truth. They carry the panel's `PANEL_TOP_INSET` gutter while the rounded
    // shell frame is shown (>=500px, same breakpoint as the sidebar) and collapse
    // to 0 at full-bleed so the profile banner / header band / tab bar pin flush
    // to the viewport top instead of leaving a stray gutter band.
    const panelStickyTopInset = usePanelStickyTopInset();
    const panelStickyTabsTopInset = usePanelStickyTabsTopInset();

    // Active tab — use local state so tab switching doesn't trigger router navigation.
    // Initialize from the route prop, then manage locally.
    const [activeTab, setActiveTab] = useState(() => tabToIndex(tab));

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
    const activeProfileTab = TAB_NAMES[activeTab] || 'posts';
    const nativeFeedOwnsScroll = shouldFeedOwnProfileScroll({
        tab: activeProfileTab,
        isWeb: IS_WEB,
        isPrivate,
        isOwnProfile,
    });
    const nativeGridOwnsScroll = shouldGridOwnProfileScroll({
        tab: activeProfileTab,
        isWeb: IS_WEB,
        isPrivate,
        isOwnProfile,
    });
    const nativeListOwnsScroll =
        nativeFeedOwnsScroll || nativeGridOwnsScroll;

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
            const path: Href =
                index === 0 ? `/@${profileHandle}` : `/@${profileHandle}/${tabName}`;
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
        } catch {
            logger.error('Error sharing profile');
        }
    }, [profileData, profileHandle, t]);

    // More options menu (block, mute, report)
    const handleMoreOptions = useCallback(() => {
        if (!profileData || isOwnProfile) return;

        const displayUsername = profileData.username;

        const handleMute = async () => {
            const success = await muteService.muteUser(profileData.id);
            if (success) {
                toast(t('profile.muted', { username: displayUsername, defaultValue: `@${displayUsername} has been muted` }), { type: 'success' });
            } else {
                toast(t('profile.muteFailed', { defaultValue: 'Failed to mute user' }), { type: 'error' });
            }
        };

        const handleBlock = async () => {
            const confirmed = await confirmDialog({
                title: t('profile.blockUser', { defaultValue: `Block @${displayUsername}` }),
                message: t('profile.blockConfirm', { username: displayUsername, defaultValue: `They won't be able to find your profile, posts, or mentions. They won't be notified that you blocked them.` }),
                okText: t('profile.block', { defaultValue: 'Block' }),
                cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
                destructive: true,
            });
            // Backing out of the confirm returns to where it was opened from —
            // the menu — instead of dumping the user back on the profile with
            // nothing to show for the trip.
            if (!confirmed) {
                openMenu();
                return;
            }
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

        const handleAddToStarterPack = () => {
            bottomSheet.setBottomSheetContent(
                <AddToStarterPackSheet
                    targetUserId={profileData.id}
                    targetLabel={`@${displayUsername}`}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const actions: ActionMenuAction[] = [
            {
                icon: <ListIcon size={22} className="text-foreground" />,
                label: t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' }),
                onPress: handleAddToList,
            },
            {
                icon: <StarterPackIcon size={22} className="text-foreground" />,
                label: t('starterPacks.addTo.menuItem', { defaultValue: 'Add/remove from starter packs' }),
                onPress: handleAddToStarterPack,
            },
            {
                icon: <MuteIcon size={22} className="text-foreground" />,
                label: t('profile.muteUser', { username: displayUsername, defaultValue: `Mute @${displayUsername}` }),
                onPress: handleMute,
            },
        ];

        const destructiveActions: ActionMenuAction[] = [
            {
                icon: <BlockIcon size={22} color={theme.colors.error} />,
                label: t('profile.blockUser', { username: displayUsername, defaultValue: `Block @${displayUsername}` }),
                onPress: handleBlock,
                color: theme.colors.error,
            },
            {
                icon: <ReportIcon size={22} color={theme.colors.error} />,
                label: t('profile.reportUser', { defaultValue: 'Report' }),
                onPress: handleReport,
                color: theme.colors.error,
            },
        ];

        // Named so the block flow can reopen the exact same menu after a
        // cancelled confirm.
        function openMenu() {
            showActionMenu({
                label: t('profile.moreOptions', { username: displayUsername, defaultValue: `Options for @${displayUsername}` }),
                groups: [actions, destructiveActions],
            });
        }

        openMenu();
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
        if (profileData?.actorUri) openExternalLink(profileData.actorUri);
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

    // Pull-to-zoom banner parallax: on overscroll (negative scroll offset, i.e.
    // pulling the content down past the top) the banner scales 1 → 1.5. Uses the
    // same `scrollY` Animated.Value as the banner fade above for consistency; on
    // web `window.scrollY` never goes negative, so this stays clamped at 1 (no
    // rubber-band there) while native's bouncing ScrollView drives the zoom.
    const bannerScale = useMemo(
        () =>
            scrollY.interpolate({
                inputRange: [-150, 0],
                outputRange: [1.5, 1],
                extrapolateLeft: 'extend',
                extrapolateRight: 'clamp',
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
        if (!isOwnProfile) count += 2; // subscribe + more
        // DM is local-only — remote (federated) actors have no Mention inbox.
        if (!isOwnProfile && !isFederated) count += 1; // DM
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

    const profileSummary = useMemo(() => {
        if (!profileData) return null;
        return (
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
                    FollowButtonComponent={OxyFollowButton}
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
        );
    }, [
        avatarUri,
        currentUser?.username,
        followerCount,
        followingCount,
        handleBoostsPress,
        handlePostsPress,
        handleRepliesPress,
        isOwnProfile,
        isPrivate,
        justFollowed,
        profileData,
        username,
    ]);

    const profileTabBar = useMemo(
        () => (
            <AnimatedTabBar
                tabs={tabs.map((tabLabel, i) => ({
                    id: String(i),
                    label: tabLabel,
                }))}
                activeTabId={String(activeTab)}
                onTabPress={(id) => onTabPress(parseInt(id))}
                scrollEnabled
                instanceId={username || 'default'}
            />
        ),
        [activeTab, onTabPress, tabs, username],
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
            {/* WEB: `web:z-auto` stops this screen wrapper from being its own
                stacking context (RN-web otherwise renders every View as
                `position:relative; z-index:0`, which would TRAP the sticky header
                chrome below it). With `z-index:auto` the profile chrome (banner
                z-1, action cluster + compact name z-101) competes directly in the
                rounded panel's stacking context, so the action/name chrome paints
                ABOVE the bleed-mask overlay (z-30) and the feed (z-3) but below the
                panel border frame (z-120) — exactly like the home header. No effect
                on native. */}
            <View className="flex-1 bg-background web:z-auto relative flex-col" style={[{ overflow: 'visible' }, themedStyles.container]}>
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
                        {/* Banner. NATIVE: `absolute left-0 right-0 top:0`
                            (height 170, zIndex 1) over the NON-scrolling root — the
                            content scrolls OVER it, and the `bg-background` overlay
                            fades it out over the first 120px via
                            `headerBackgroundOpacity`. WEB: there is no inner
                            ScrollView (the DOCUMENT scrolls), so an `absolute` banner
                            would scroll away. Instead it is `web:sticky` +
                            `panelStickyTopInset` (pinned to the rounded panel's
                            PANEL_TOP_INSET top-gutter inset — from the single shared
                            constant, no literal `top-2` here — and sticky's
                            containing block is the panel column, so it stays
                            INSIDE the panel, never viewport-fixed). The negative
                            bottom margin (`-170px`) cancels its flow height so the
                            content's own `marginTop + paddingTop` offset is NOT
                            double-counted — the banner occupies 0 net flow and the
                            content still starts ~170px down and scrolls over it, then
                            the banner fades to the background, exactly as on native.
                            Its `web:z-[1]` keeps it BELOW the content (`zIndex: 3`),
                            preserving native's content-over-banner layering. */}
                        {!minimalistMode &&
                            (bannerUri ? (
                                <View
                                    className="left-0 right-0 overflow-hidden web:sticky web:z-[1] web:[margin-bottom:-170px]"
                                    style={[webStickyChrome.banner, panelStickyTopInset, { height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED }]}
                                >
                                    <AnimatedImageBackground
                                        source={{ uri: bannerUri }}
                                        className="absolute left-0 right-0 top-0 overflow-hidden"
                                        style={{
                                            height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
                                            transform: [{ scale: bannerScale }],
                                        }}
                                    />
                                    <Animated.View
                                        className="absolute left-0 right-0 top-0 overflow-hidden bg-background"
                                        style={{
                                            height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED,
                                            zIndex: 1,
                                            pointerEvents: 'none',
                                            opacity: headerBackgroundOpacity,
                                        }}
                                    />
                                </View>
                            ) : (
                                <View
                                    className="left-0 right-0 overflow-hidden bg-primary/[0.125] web:sticky web:z-[1] web:[margin-bottom:-170px]"
                                    style={[webStickyChrome.banner, panelStickyTopInset, { height: LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED }]}
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

                        {/* Pinned header-band surface (WEB only). When the header
                            chrome is pinned in contact with the tab bar, the action
                            cluster + compact-name overlay are 0-flow-height anchors
                            with NO background of their own — so the scrolling feed
                            (z-3) would show THROUGH the header band while the opaque
                            tabs (`bg-background`) sit right below, reading as an
                            incoherent transparent-header / opaque-tabs split. This
                            sticky surface fills the 48px header band (PANEL_TOP_INSET
                            .. PANEL_TOP_INSET + PANEL_HEADER_HEIGHT, i.e. flush with
                            the tabs at top:56) with the SAME `bg-background` token the
                            tab bar uses, so header + tabs read as ONE cohesive opaque
                            bar. Its opacity is driven by the SAME
                            `headerBackgroundOpacity` as the banner fade: 0 when
                            expanded (the banner shows through — restored parallax
                            preserved) → 1 once scrolled (opaque, matching the tabs).
                            `web:z-[100]` paints it ABOVE the feed content (z-3) and the
                            tabs (z-5) but BELOW the chrome icons/name overlay (z-101),
                            so the icons stay on top. It intentionally receives web
                            pointer events to prevent clicks from reaching covered feed
                            content while the band is opaque; the higher z-101 header
                            controls remain interactive. The `-48px` bottom margin
                            (cancels its flow height, like the banner's `-170px`)
                            keeps it a 0-flow overlay. Empty on native, where the chrome
                            is an absolute overlay over the non-scrolling root. */}
                        {IS_WEB && (
                            <View
                                className="left-0 right-0 web:sticky web:z-[100] web:pointer-events-auto web:[margin-bottom:-48px]"
                                style={[panelStickyTopInset, { height: PANEL_HEADER_HEIGHT }]}
                            >
                                <Animated.View
                                    className="bg-background"
                                    style={[StyleSheet.absoluteFill, { opacity: headerBackgroundOpacity }]}
                                />
                            </View>
                        )}

                        {/* Header actions cluster (subscribe / DM / open-instance /
                            share / more). NATIVE: `absolute`, `top: insets.top+6`,
                            `right: DEFAULT_PADDING-8`, zIndex 10 — pinned at the top
                            of the non-scrolling root. WEB: the cluster lives inside a
                            full-width `web:sticky` + `panelStickyTopInset` wrapper
                            pinned to the panel's PANEL_TOP_INSET top-gutter inset
                            (same pattern as the PanelStickyHeader the home header
                            uses — sticky's containing block is the panel column, so
                            the cluster stays INSIDE the panel, never viewport-fixed).
                            The wrapper has 0 flow height (its only child is
                            `absolute`) and is `pointer-events-none` so it never blocks
                            the feed; the cluster itself re-enables pointer events. Its
                            `web:z-[101]` matches the home header so it paints above
                            the feed/content (z-3) and the bleed mask (z-30) but below
                            the panel's border frame (z-120). */}
                        <View className="left-0 right-0 web:sticky web:z-[101] web:pointer-events-none" style={[webStickyChrome.chromeAnchor, panelStickyTopInset]}>
                            <View
                                className="absolute flex-row items-center gap-1 web:pointer-events-auto"
                                style={[{ zIndex: 10, right: LAYOUT.DEFAULT_PADDING - 8 }, themedStyles.headerActions]}
                            >
                                {/* The bell is a toggle rendered as two different
                                    glyphs, so its label has to carry the state a
                                    sighted user reads from the icon — a static
                                    "Notifications" would leave a screen reader
                                    unable to tell subscribed from not. */}
                                {!isOwnProfile && (
                                    <IconButton
                                        variant="icon"
                                        onPress={toggleSubscription}
                                        disabled={subLoading}
                                        accessibilityLabel={
                                            subscribed
                                                ? t('profile.actions.unsubscribe', {
                                                    handle: profileHandle,
                                                    defaultValue: 'Stop notifying me about new posts from @{{handle}}',
                                                })
                                                : t('profile.actions.subscribe', {
                                                    handle: profileHandle,
                                                    defaultValue: 'Notify me about new posts from @{{handle}}',
                                                })
                                        }
                                    >
                                        {subscribed ? (
                                            <BellActive size={18} className="text-primary" />
                                        ) : (
                                            <Bell size={18} className="text-foreground" />
                                        )}
                                    </IconButton>
                                )}
                                {!isOwnProfile && !isFederated && (
                                    <IconButton
                                        variant="icon"
                                        onPress={handleDM}
                                        accessibilityLabel={t('profile.actions.message', {
                                            handle: profileHandle,
                                            defaultValue: 'Message @{{handle}}',
                                        })}
                                    >
                                        <MailIcon size={18} className="text-foreground" />
                                    </IconButton>
                                )}
                                {isFederated && (
                                    <IconButton
                                        variant="icon"
                                        onPress={handleOpenOnInstance}
                                        accessibilityLabel={t('profile.actions.openOnInstance', {
                                            handle: profileHandle,
                                            defaultValue: 'Open @{{handle}} on their home instance',
                                        })}
                                    >
                                        <ExternalLinkIcon size={18} className="text-foreground" />
                                    </IconButton>
                                )}
                                <IconButton
                                    variant="icon"
                                    onPress={handleShare}
                                    accessibilityLabel={t('profile.actions.share', {
                                        handle: profileHandle,
                                        defaultValue: "Share @{{handle}}'s profile",
                                    })}
                                >
                                    <ShareIcon size={18} className="text-foreground" />
                                </IconButton>
                                {!isOwnProfile && (
                                    <IconButton
                                        variant="icon"
                                        onPress={handleMoreOptions}
                                        accessibilityLabel={t('profile.actions.more', {
                                            handle: profileHandle,
                                            defaultValue: 'More options for @{{handle}}',
                                        })}
                                    >
                                        <MoreIcon size={18} className="text-foreground" />
                                    </IconButton>
                                )}
                            </View>
                        </View>

                        {/* Compact name overlay (avatar + name + posts-count), fades
                            in via `headerNameOpacity` once the real name scrolls past.
                            NATIVE: `absolute`, `top: insets.top+6`, `left:
                            DEFAULT_PADDING`, `right: headerOverlayRight` (truncates
                            before the action icons), zIndex 10. WEB: same full-width
                            `web:sticky` + `panelStickyTopInset` wrapper as the
                            actions cluster, so it pins to the panel's PANEL_TOP_INSET
                            top-gutter inset INSIDE the panel (never viewport-fixed).
                            The fade is driven by the same
                            window-fed `scrollY` interpolation as native. The overlay
                            is `pointer-events-none` (matching native), and the wrapper
                            consumes 0 net flow height. */}
                        <View className="left-0 right-0 web:sticky web:z-[101] web:pointer-events-none" style={[webStickyChrome.chromeAnchor, panelStickyTopInset]}>
                            <Animated.View
                                className="absolute"
                                style={[
                                    { zIndex: 10, left: LAYOUT.DEFAULT_PADDING, flexDirection: 'row', alignItems: 'center', gap: 10 },
                                    themedStyles.headerNameOverlay,
                                    { opacity: headerNameOpacity },
                                    { pointerEvents: 'none' },
                                ]}
                            >
                                <Avatar
                                    source={avatarUri}
                                    size={32}
                                    variant={MEDIA_VARIANT_AVATAR}
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
                        </View>

                        {/* Main scroll content.

                            NATIVE FEED TABS: Feed's FlashList owns the scroll and
                            receives profile info as `ListHeaderComponent` and
                            tabs as a separate sticky data row, keeping post rows
                            virtualized without pinning the whole summary.
                            NATIVE GRID TABS: ProfileGridList's FlashList owns the
                            scroll with the same header/sticky-tab row contract.
                            The existing Animated.ScrollView remains the sole
                            owner only for the bounded card tabs.

                            WEB: the DOCUMENT scrolls (no inner ScrollView — that
                            would break the document-scroll model the home/explore
                            screens use). The body renders in normal flow inside a
                            plain `View`; the header/banner/name-overlay animations
                            read the same `scrollY` shared value, now fed by the
                            window 'scroll' listener in LayoutScrollContext. The tab
                            bar pins via `web:sticky` (its own `bg-background` keeps
                            the feed from showing through). */}
                        {IS_WEB ? (
                            <View style={[{ zIndex: 3 }, themedStyles.scrollView, themedStyles.contentContainer]}>
                                {/* Profile info + suggestions */}
                                {profileSummary}

                                {/* Tabs — sticky in the SECOND tier, pinned flush
                                    BELOW the header chrome band (`web:sticky` +
                                    `panelStickyTabsTopInset` = PANEL_TOP_INSET +
                                    PANEL_HEADER_HEIGHT while framed, the same 56px
                                    offset the home screen's `level={1}` tab bar uses;
                                    it collapses to just PANEL_HEADER_HEIGHT at
                                    full-bleed, in lockstep with the first-tier inset).
                                    The banner fade, action cluster and compact-name
                                    overlay above all pin at the FIRST tier
                                    (`panelStickyTopInset`, PANEL_TOP_INSET while framed,
                                    0 at full-bleed); pinning the tab bar at that same
                                    inset made the two bands occupy the same vertical
                                    space and OVERLAP. Stacking the tabs one header
                                    height down lands them directly under the header
                                    chrome — header on top, tabs flush below — while
                                    the document scrolls (mirrors native's
                                    `stickyHeaderIndices={[1]}` pinning below the
                                    absolute header overlay). It lives inside the z-3
                                    content wrapper, so `web:z-[5]` keeps it above the
                                    feed content (which scrolls under it); the
                                    `bg-background` on AnimatedTabBar keeps the feed
                                    from showing through, and the pinned tab bar paints
                                    over the lower-z banner that sits behind it. */}
                                <View className="web:sticky web:z-[5]" style={panelStickyTabsTopInset}>
                                    {profileTabBar}
                                </View>

                                {/* Tab content */}
                                <ProfileTabs
                                    tab={activeProfileTab}
                                    profileId={profileData?.id}
                                    isPrivate={isPrivate}
                                    isOwnProfile={isOwnProfile}
                                    isFederated={isFederated}
                                    actorUri={profileData?.actorUri}
                                />
                            </View>
                        ) : nativeListOwnsScroll ? (
                            <View
                                style={[
                                    {
                                        zIndex: 3,
                                        flex: 1,
                                        minHeight: 0,
                                    },
                                    themedStyles.scrollView,
                                ]}
                            >
                                <ProfileTabs
                                    tab={activeProfileTab}
                                    profileId={profileData.id}
                                    isPrivate={isPrivate}
                                    isOwnProfile={isOwnProfile}
                                    isFederated={isFederated}
                                    actorUri={profileData.actorUri}
                                    listOwnsScroll
                                    listHeaderComponent={profileSummary}
                                    listStickyHeaderComponent={profileTabBar}
                                    listContentContainerStyle={themedStyles.contentContainer}
                                    listOnScroll={nativeGridOwnsScroll ? onScroll : undefined}
                                    listScrollRef={nativeGridOwnsScroll ? assignScrollRef : undefined}
                                />
                            </View>
                        ) : (
                            <Animated.ScrollView
                                ref={assignScrollRef}
                                showsVerticalScrollIndicator={false}
                                onScroll={onScroll}
                                scrollEventThrottle={16}
                                style={[{ zIndex: 3 }, themedStyles.scrollView]}
                                contentContainerStyle={themedStyles.contentContainer}
                                stickyHeaderIndices={[1]}
                                nestedScrollEnabled={true}
                                removeClippedSubviews={true}
                                disableIntervalMomentum={true}
                                decelerationRate="normal"
                            >
                                {/* Profile info + suggestions wrapper (keeps stickyHeaderIndices stable) */}
                                {profileSummary}

                                {/* Tabs */}
                                {profileTabBar}

                                {/* Tab content */}
                                <ProfileTabs
                                    tab={activeProfileTab}
                                    profileId={profileData.id}
                                    isPrivate={isPrivate}
                                    isOwnProfile={isOwnProfile}
                                    isFederated={isFederated}
                                    actorUri={profileData?.actorUri}
                                />
                            </Animated.ScrollView>
                        )}

                        {/* FAB that rides the BottomBar's show/hide (web mobile). */}
                        <BottomBarAwareFab
                            onPress={() => router.push('/compose')}
                            icon={<ComposeIcon size={20} className="text-primary-foreground" />}
                            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
                        />

                    </>
                )}
            </View>
        </>
    );
};

// WEB vs NATIVE positioning for the profile header chrome (banner, action
// cluster, compact-name overlay). NATIVE pins each piece `absolute` to the top
// of the NON-scrolling root (the content scrolls over them inside the inner
// Animated.ScrollView). WEB has no inner ScrollView — the DOCUMENT scrolls — so
// each piece pins via `web:sticky` + the shared `panelStickyTopInset` style
// (the rounded panel's PANEL_TOP_INSET top-gutter inset, from the single
// PanelChrome source of truth — no literal `top-2` here). `position: sticky`
// keeps the panel column as its containing block, so the chrome stays INSIDE the
// rounded center panel (never viewport-fixed), mirroring the home header's
// PanelStickyHeader. These bespoke overlapping layers keep their own `web:z-[…]`,
// negative margins and pointer-events, so they consume `panelStickyTopInset`
// rather than the full <PanelStickyHeader> wrapper (which would flatten their
// z-layout and break the banner/name fades). The web `position`/`z` live in
// NativeWind classes; this StyleSheet only supplies the native `absolute` anchor
// (web entries are empty so the classes win).
const webStickyChrome = StyleSheet.create({
    banner: {
        ...Platform.select({
            web: {},
            default: { position: 'absolute' as const, top: 0, zIndex: 1 },
        }),
    },
    chromeAnchor: {
        ...Platform.select({
            web: {},
            default: { position: 'absolute' as const, top: 0, zIndex: 10 },
        }),
    },
});

const MentionProfile: React.FC<ProfileScreenProps> = ({ tab = 'posts' }) => {
    let { username: urlUsername } = useLocalSearchParams<{ username: string }>();
    if (urlUsername?.startsWith('@')) {
        urlUsername = urlUsername.slice(1);
    }
    const username = urlUsername || '';
    const isFederated = username.includes('@');
    const { data: profileData, loading } = useProfileData(username);
    const { colorName: profileColorName } = useProfileScreenColor({
        username,
        designColor: profileData?.design?.color,
    });

    return (
        <BloomColorScope colorPreset={profileColorName} asChild>
            {/* `web:z-auto` so this profile wrapper does not become its own
                stacking context and trap the sticky header chrome below the
                panel's bleed-mask/border overlays (see MentionProfileContent's
                root for the full rationale). No effect on native. */}
            <View className="flex-1 bg-background web:z-auto">
                <MentionProfileContent
                    tab={tab}
                    username={username}
                    isFederated={isFederated}
                    profileData={profileData}
                    loading={loading}
                />
            </View>
        </BloomColorScope>
    );
};


export default MentionProfile;
