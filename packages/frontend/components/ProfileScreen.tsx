import { useTheme } from "@/hooks/useTheme";
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef, useState, useEffect, useMemo, useCallback, memo } from 'react';
import {
    Animated,
    ImageBackground,
    Image,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Share,
    Platform,
    useWindowDimensions,
} from 'react-native';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useOxy } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { Feed } from './Feed/index';
import { usePostsStore } from '@/stores/postsStore';
import type { FeedType } from '@mention/shared-types';
import MediaGrid from '@/components/Profile/MediaGrid';
import VideosGrid from '@/components/Profile/VideosGrid';
import { subscriptionService } from '@/services/subscriptionService';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { Search } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import SEO from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { toast } from 'sonner';

// Constants
const HEADER_HEIGHT_EXPANDED = 120;
const HEADER_HEIGHT_NARROWED = 50;
const SCROLL_CHECK_THROTTLE = 180; // ms - balanced for snappy feel
const LOAD_MORE_THRESHOLD = 500; // pixels from bottom
const FEED_LIMIT = 20;
const TAB_NAMES = ['posts', 'replies', 'media', 'videos', 'likes', 'reposts'] as const;
const DEFAULT_PADDING = 16;
const FAB_BOTTOM_MARGIN = 24;
const FAB_RIGHT_MARGIN = 24;

// Type definitions
interface ProfileScreenProps {
    tab?: 'posts' | 'replies' | 'media' | 'videos' | 'likes' | 'reposts';
}

type FollowButtonComponent = React.ComponentType<{ userId: string }>;
type UserNameComponent = React.ComponentType<{
    name?: string | null;
    handle?: string;
    verified?: boolean;
    variant?: 'default' | 'small';
    style?: {
        name?: any;
        handle?: any;
        container?: any;
    };
    unifiedColors?: boolean;
}>;

// Helper functions
const isProfilePrivate = (profileData: ProfileData | null, privacySettings?: ProfileData['privacy']): boolean => {
    if (!profileData) return false;
    return Boolean(
        profileData.privacySettings?.isPrivateAccount ||
        privacySettings?.profileVisibility === 'private' ||
        privacySettings?.profileVisibility === 'followers_only'
    );
};

const tabToIndex = (tabName: string): number => {
    const index = TAB_NAMES.indexOf(tabName as typeof TAB_NAMES[number]);
    return index >= 0 ? index : 0;
};

// Extracted Components
const ProfileSkeleton = memo<{ theme: ReturnType<typeof useTheme> }>(({ theme }) => {
    const { SkeletonCircle, SkeletonText, SkeletonPill } = require('@/components/Skeleton');

    return (
        <View style={[styles.skeletonContainer, { backgroundColor: theme.colors.background }]}>
            <View style={[styles.skeletonBanner, { backgroundColor: theme.colors.backgroundSecondary, height: 150 }]} />
            <View style={styles.skeletonContent}>
                <View style={styles.skeletonAvatarRow}>
                    <SkeletonCircle size={90} style={{ borderWidth: 3, borderColor: theme.colors.background }} />
                    <View style={{ flex: 1 }} />
                    <SkeletonPill size={36} style={{ width: 100, height: 36, marginRight: 8 }} />
                    <SkeletonCircle size={36} />
                </View>
                <SkeletonText style={{ width: '40%', fontSize: 20, marginTop: 12 }} />
                <SkeletonText style={{ width: '30%', fontSize: 14, marginTop: 8 }} />
                <SkeletonText style={{ width: '90%', fontSize: 14, marginTop: 12 }} />
                <SkeletonText style={{ width: '80%', fontSize: 14, marginTop: 8 }} />
                <View style={[styles.skeletonMetaRow, { marginTop: 12 }]}>
                    <SkeletonPill size={24} style={{ width: 120, height: 24 }} />
                    <SkeletonPill size={24} style={{ width: 160, height: 24, marginLeft: 8 }} />
                    <SkeletonPill size={24} style={{ width: 180, height: 24, marginLeft: 8 }} />
                </View>
                <View style={[styles.skeletonTabs, { borderColor: theme.colors.border, marginTop: 16 }]}>
                    {[...Array(5)].map((_, i) => (
                        <SkeletonPill key={i} size={32} style={{ width: 60, height: 32, marginRight: 8 }} />
                    ))}
                </View>
            </View>
        </View>
    );
});
ProfileSkeleton.displayName = 'ProfileSkeleton';

const PrivateBadge = memo<{
    privacySettings?: ProfileData['privacy'];
    theme: ReturnType<typeof useTheme>;
    t: (key: string) => string;
}>(({ privacySettings, theme, t }) => {
    const isFollowersOnly = privacySettings?.profileVisibility === 'followers_only';
    return (
        <View style={styles.privateIndicator}>
            <Ionicons name="lock-closed" size={12} color={theme.colors.textSecondary} />
            <Text style={[styles.privateText, { color: theme.colors.textSecondary }]}>
                {isFollowersOnly ? t('settings.privacy.followersOnly') : t('settings.privacy.private')}
            </Text>
        </View>
    );
});
PrivateBadge.displayName = 'PrivateBadge';

const ProfileHeaderMinimalist = memo<{
    displayName: string;
    username?: string;
    avatarUri?: string;
    verified?: boolean;
    isPrivate: boolean;
    privacySettings?: ProfileData['privacy'];
    theme: ReturnType<typeof useTheme>;
    UserNameComponent: UserNameComponent;
    t: (key: string) => string;
}>(({ displayName, username, avatarUri, verified, isPrivate, privacySettings, theme, UserNameComponent, t }) => (
    <>
        <View style={styles.minimalistHeader}>
            <View style={styles.minimalistInfo}>
                <UserNameComponent
                    name={displayName}
                    handle={username}
                    verified={false}
                    variant="default"
                    style={{
                        name: [styles.profileName, { color: theme.colors.text }],
                        handle: [styles.profileHandle, { color: theme.colors.textSecondary }],
                        container: undefined,
                    }}
                />
                {isPrivate && <PrivateBadge privacySettings={privacySettings} theme={theme} t={t} />}
            </View>
            <View style={styles.minimalistAvatarContainer}>
                <ZoomableAvatar
                    source={avatarUri}
                    size={70}
                    style={[styles.avatarMinimalist, {
                        borderColor: theme.colors.background,
                        backgroundColor: theme.colors.backgroundSecondary,
                    }]}
                    imageStyle={{}}
                />
                {verified && (
                    <View style={[styles.verifiedBadgeMinimalist, { backgroundColor: theme.colors.background }]}>
                        <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                    </View>
                )}
            </View>
        </View>
    </>
));
ProfileHeaderMinimalist.displayName = 'ProfileHeaderMinimalist';

const ProfileHeaderDefault = memo<{
    displayName: string;
    username?: string;
    avatarUri?: string;
    verified?: boolean;
    isOwnProfile: boolean;
    currentUsername?: string;
    profileId?: string;
    theme: ReturnType<typeof useTheme>;
    UserNameComponent: UserNameComponent;
    FollowButtonComponent: FollowButtonComponent;
    showBottomSheet?: (sheet: string) => void;
    t: (key: string) => string;
}>(({ displayName, username, avatarUri, verified, isOwnProfile, currentUsername, profileId, theme, UserNameComponent, FollowButtonComponent, showBottomSheet, t }) => (
    <View style={styles.avatarRow}>
        <ZoomableAvatar
            source={avatarUri}
            size={90}
            style={[styles.avatar, {
                borderColor: theme.colors.background,
                backgroundColor: theme.colors.backgroundSecondary,
            }]}
            imageStyle={{}}
        />
        <View style={styles.profileActions}>
            {isOwnProfile && currentUsername === username ? (
                <View style={styles.actionButtons}>
                    <TouchableOpacity
                        style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
                        onPress={() => showBottomSheet?.('EditProfile')}
                    >
                        <Text style={styles.followButtonText}>{t('profile.editProfile')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingsButton, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}
                        onPress={() => router.push('/insights')}
                    >
                        <AnalyticsIcon size={20} color={theme.colors.text} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingsButton, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}
                        onPress={() => router.push('/settings')}
                    >
                        <Gear size={20} color={theme.colors.text} />
                    </TouchableOpacity>
                </View>
            ) : profileId ? (
                <FollowButtonComponent userId={profileId} />
            ) : null}
        </View>
    </View>
));
ProfileHeaderDefault.displayName = 'ProfileHeaderDefault';

const ProfileActions = memo<{
    isOwnProfile: boolean;
    currentUsername?: string;
    profileUsername?: string;
    profileId?: string;
    theme: ReturnType<typeof useTheme>;
    FollowButtonComponent: FollowButtonComponent;
    showBottomSheet?: (sheet: string) => void;
    t: (key: string) => string;
}>(({ isOwnProfile, currentUsername, profileUsername, profileId, theme, FollowButtonComponent, showBottomSheet, t }) => {
    if (!isOwnProfile || currentUsername !== profileUsername) {
        return profileId ? <FollowButtonComponent userId={profileId} /> : null;
    }

    return (
        <View style={styles.actionButtons}>
            <TouchableOpacity
                style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
                onPress={() => showBottomSheet?.('EditProfile')}
            >
                <Text style={styles.followButtonText}>{t('profile.editProfile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.settingsButton, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}
                onPress={() => router.push('/insights')}
            >
                <AnalyticsIcon size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.settingsButton, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}
                onPress={() => router.push('/settings')}
            >
                <Gear size={20} color={theme.colors.text} />
            </TouchableOpacity>
        </View>
    );
});
ProfileActions.displayName = 'ProfileActions';

const ProfileStats = memo<{
    followingCount: number;
    followerCount: number;
    profileUsername?: string;
    username: string;
    theme: ReturnType<typeof useTheme>;
    t: (key: string) => string;
}>(({ followingCount, followerCount, profileUsername, username, theme, t }) => (
    <View style={styles.followStats}>
        <TouchableOpacity
            style={styles.statItem}
            onPress={() => router.push(`/@${profileUsername || username}/following` as any)}
        >
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>
                {followingCount ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>{t('profile.following')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
            style={styles.statItem}
            onPress={() => router.push(`/@${profileUsername || username}/followers` as any)}
        >
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>
                {followerCount ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>{t('profile.followers')}</Text>
        </TouchableOpacity>
    </View>
));
ProfileStats.displayName = 'ProfileStats';

interface Community {
    id?: string;
    name: string;
    description?: string;
    icon?: string;
    memberCount?: number;
}

const ProfileCommunities = memo<{
    communities: Community[];
    theme: ReturnType<typeof useTheme>;
    t: (key: string) => string;
}>(({ communities, theme, t }) => (
    <View style={styles.communitiesSection}>
        <Text style={[styles.communitiesTitle, { color: theme.colors.text }]}>{t('profile.communities')}</Text>
        {communities.map((community, index) => (
            <View key={community.id || index} style={[styles.communityCard, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                <View style={styles.communityHeader}>
                    {community.icon && (
                        <View style={styles.communityIcon}>
                            <Image
                                source={{ uri: community.icon }}
                                resizeMode="cover"
                                style={styles.communityIconImage}
                            />
                        </View>
                    )}
                    <View style={styles.communityInfo}>
                        <Text style={[styles.communityName, { color: theme.colors.text }]}>{community.name}</Text>
                        {community.description && (
                            <Text style={[styles.communityDescription, { color: theme.colors.textSecondary }]}>
                                {community.description}
                            </Text>
                        )}
                        {community.memberCount && (
                            <View style={styles.communityMembers}>
                                <Text style={[styles.memberCount, { color: theme.colors.textSecondary }]}>
                                    {(t as any)('profile.memberCount', {
                                        count: community.memberCount,
                                        defaultValue: `${community.memberCount} Members`
                                    })}
                                </Text>
                            </View>
                        )}
                    </View>
                </View>
                <TouchableOpacity style={styles.viewButtonInCard}>
                    <Text style={[styles.viewButtonText, { color: theme.colors.primary }]}>{t('profile.view')}</Text>
                </TouchableOpacity>
            </View>
        ))}
    </View>
));
ProfileCommunities.displayName = 'ProfileCommunities';

const ProfileTabs = memo<{
    tab: string;
    profileId?: string;
    isPrivate: boolean;
    isOwnProfile: boolean;
    theme: ReturnType<typeof useTheme>;
    t: (key: string) => string;
}>(({ tab, profileId, isPrivate, isOwnProfile, theme, t }) => {
    // If profile is private and not own profile, show message instead of content
    // This prevents any feed loading attempts
    if (isPrivate && !isOwnProfile) {
        return (
            <View style={{ padding: 32, alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
                <Ionicons name="lock-closed" size={48} color={theme.colors.textSecondary} style={{ marginBottom: 16 }} />
                <Text style={[styles.privateProfileMessage, { color: theme.colors.text }]}>
                    {(t as any)('profile.private.message', { defaultValue: 'This profile is private' })}
                </Text>
                <Text style={[styles.privateProfileSubtext, { color: theme.colors.textSecondary }]}>
                    {(t as any)('profile.private.subtext', { defaultValue: 'Follow this account to see their posts' })}
                </Text>
            </View>
        );
    }

    // Only render feed components if user has access
    if (tab === 'media') {
        return <MediaGrid userId={profileId} isPrivate={isPrivate} isOwnProfile={isOwnProfile} />;
    }

    if (tab === 'videos') {
        return <VideosGrid userId={profileId} isPrivate={isPrivate} isOwnProfile={isOwnProfile} />;
    }

    return (
        <Feed
            type={tab as FeedType}
            userId={profileId}
            hideHeader={true}
            scrollEnabled={false}
            contentContainerStyle={{ paddingBottom: 100 }}
        />
    );
});
ProfileTabs.displayName = 'ProfileTabs';

// Feed types constant - only include valid FeedType values
const FEED_TYPES: FeedType[] = ['posts', 'replies', 'media', 'likes', 'reposts'];

const MentionProfile: React.FC<ProfileScreenProps> = ({ tab = 'posts' }) => {
    const { user: currentUser, oxyServices, showBottomSheet, useFollow } = useOxy();
    const theme = useTheme();
    const { t } = useTranslation();

    // Type-safe component references
    const FollowButtonComponent = (OxyServicesNS as { FollowButton?: FollowButtonComponent }).FollowButton as FollowButtonComponent;
    const UserNameComponent = UserName as UserNameComponent;

    let { username: urlUsername } = useLocalSearchParams<{ username: string }>();
    if (urlUsername && urlUsername.startsWith('@')) {
        urlUsername = urlUsername.slice(1);
    }
    const username = urlUsername || '';

    const activeTab = useMemo(() => tabToIndex(tab), [tab]);

    // Unified profile data hook
    const { data: profileData, loading } = useProfileData(username);
    const {
        scrollY,
        createAnimatedScrollHandler,
        registerScrollable,
    } = useLayoutScroll();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();

    // Refs for scroll handling
    const loadingMoreRef = useRef(false);
    const profileScrollRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const lastScrollCheckRef = useRef(0);

    // Pre-read store methods for performance
    const fetchUserFeedRef = useRef<((userId: string, request: { type: FeedType; cursor?: string; limit: number }) => Promise<void>) | null>(null);
    const getUserSliceRef = useRef<((userId: string, type: FeedType) => {
        hasMore: boolean;
        nextCursor?: string;
        isLoading: boolean;
    } | undefined) | null>(null);

    useEffect(() => {
        const store = usePostsStore.getState();
        fetchUserFeedRef.current = store.fetchUserFeed;
        getUserSliceRef.current = (userId: string, type: FeedType) => {
            const state = usePostsStore.getState();
            return state.userFeeds[userId]?.[type];
        };
    }, []);

    const clearProfileRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignProfileScrollRef = useCallback((node: any) => {
        profileScrollRef.current = node;
        clearProfileRegistration();
        if (node && registerScrollable) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearProfileRegistration, registerScrollable]);

    // Optimized scroll handler
    const handleProfileScrollEvent = useCallback((event: any) => {
        const now = Date.now();
        if (now - lastScrollCheckRef.current < SCROLL_CHECK_THROTTLE) {
            return;
        }
        lastScrollCheckRef.current = now;

        try {
            const nativeEvent = event?.nativeEvent ?? {};
            const contentOffset = nativeEvent.contentOffset ?? {};
            const layoutMeasurement = nativeEvent.layoutMeasurement ?? {};
            const contentSize = nativeEvent.contentSize ?? {};
            const fallbackY = typeof nativeEvent.target?.scrollTop === 'number'
                ? nativeEvent.target.scrollTop
                : typeof event?.target?.scrollTop === 'number'
                    ? event.target.scrollTop
                    : 0;
            const y = typeof contentOffset.y === 'number' ? contentOffset.y : fallbackY;
            const viewH = layoutMeasurement?.height || 0;
            const contentH = contentSize?.height || 0;
            const distanceFromBottom = contentH - (y + viewH);

            if (distanceFromBottom < LOAD_MORE_THRESHOLD) {
                const uid = profileData?.id;
                if (!uid || loadingMoreRef.current || !fetchUserFeedRef.current || !getUserSliceRef.current) return;

                const slice = getUserSliceRef.current(uid, tab as FeedType);
                if (slice && slice.hasMore && !slice.isLoading) {
                    loadingMoreRef.current = true;
                    void (async () => {
                        try {
                            await fetchUserFeedRef.current!(uid, { type: tab as FeedType, cursor: slice.nextCursor, limit: FEED_LIMIT });
                        } finally {
                            loadingMoreRef.current = false;
                        }
                    })();
                }
            }
        } catch {
            // ignore scroll read errors
        }
    }, [tab, profileData?.id]);

    const onProfileScroll = useMemo(
        () => createAnimatedScrollHandler(handleProfileScrollEvent),
        [createAnimatedScrollHandler, handleProfileScrollEvent]
    );

    useEffect(() => () => {
        clearProfileRegistration();
    }, [clearProfileRegistration]);

    // Stable userId for useFollow - use empty string if no profile to avoid hook issues
    const stableUserId = profileData?.id || '';
    const {
        followerCount = 0,
        followingCount = 0,
    } = (useFollow as (userId: string) => { followerCount?: number; followingCount?: number })(stableUserId);

    // Extract computed values from unified profile data
    const design = profileData?.design;
    const displayName = design?.displayName || '';
    const avatarUri = design?.avatar ? oxyServices.getFileDownloadUrl(design.avatar, 'thumb') : undefined;
    const bannerUri = (design?.coverPhotoEnabled && design?.coverImage)
        ? oxyServices.getFileDownloadUrl(design.coverImage, 'full')
        : undefined;
    const minimalistMode = design?.minimalistMode ?? false;
    const privacySettings = profileData?.privacy;

    // Memoized tabs array
    const tabs = useMemo(() => [
        t('profile.tabs.posts'),
        t('profile.tabs.replies'),
        t('profile.tabs.media'),
        t('profile.tabs.videos'),
        t('profile.tabs.likes'),
        t('profile.tabs.reposts')
    ], [t]);

    // Memoize own profile check
    const isOwnProfile = useMemo(() => {
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id]);

    // Memoize privacy check
    const isPrivate = useMemo(() => isProfilePrivate(profileData, privacySettings), [profileData, privacySettings]);

    // Clear cached feed data immediately if profile is private and not own profile
    // This prevents showing cached posts from when the profile was public
    useEffect(() => {
        if (isPrivate && !isOwnProfile && profileData?.id) {
            const { clearUserFeed } = usePostsStore.getState();
            // Clear all feed types for this user immediately
            FEED_TYPES.forEach((type) => {
                clearUserFeed(profileData.id, type);
            });
        }
    }, [isPrivate, isOwnProfile, profileData?.id]);

    // Subscription state
    const [subscribed, setSubscribed] = useState<boolean>(false);
    const [subLoading, setSubLoading] = useState<boolean>(false);

    // Load subscription status
    useEffect(() => {
        if (isOwnProfile || !profileData?.id) return;

        let cancelled = false;
        const load = async () => {
            try {
                const { subscribed } = await subscriptionService.getStatus(profileData.id);
                if (!cancelled) setSubscribed(!!subscribed);
            } catch (error) {
                console.error('Error loading subscription status:', error);
            }
        };
        load();
        return () => { cancelled = true; };
    }, [profileData?.id, isOwnProfile]);

    const toggleSubscription = useCallback(async () => {
        if (!profileData?.id || subLoading || isOwnProfile) return;

        setSubLoading(true);
        const prev = subscribed;
        setSubscribed(!prev);
        try {
            if (!prev) {
                await subscriptionService.subscribe(profileData.id);
                toast.success(t('subscription.subscribed'));
            } else {
                await subscriptionService.unsubscribe(profileData.id);
                toast.success(t('subscription.unsubscribed'));
            }
        } catch (error: any) {
            setSubscribed(prev);
            const errorMessage = error?.response?.data?.message || error?.message || t('subscription.error');
            toast.error(errorMessage);
            console.error('Error toggling subscription:', error);
        } finally {
            setSubLoading(false);
        }
    }, [profileData?.id, subLoading, subscribed, isOwnProfile, t]);

    const onTabPress = useCallback((index: number) => {
        if (!username) return;
        const tabName = TAB_NAMES[index];
        const path = index === 0
            ? `/@${username}`
            : `/@${username}/${tabName}`;
        router.push(path as any);
    }, [username]);

    const handleShare = useCallback(async () => {
        if (!profileData) return;

        try {
            const shareUrl = `https://mention.earth/@${profileData.username}`;
            const shareMessage = t('profile.share.message', {
                name: displayName || profileData.username,
                defaultValue: `Check out ${displayName || profileData.username}'s profile on Mention!`
            });

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: t('profile.share.title', {
                    name: displayName || profileData.username,
                    defaultValue: `${displayName || profileData.username} on Mention`
                })
            });
        } catch (error) {
            console.error('Error sharing profile:', error);
        }
    }, [profileData, displayName, t]);

    // Header background opacity animation
    const headerBackgroundOpacity = useMemo(() => scrollY.interpolate({
        inputRange: [0, HEADER_HEIGHT_EXPANDED],
        outputRange: [0, 1],
        extrapolate: 'clamp',
    }), [scrollY]);

    // Memoized SEO data
    const profileDisplayName = useMemo(() => displayName || profileData?.username || username, [displayName, profileData?.username, username]);
    const profileBio = useMemo(() => profileData?.bio || '', [profileData?.bio]);
    const profileImage = useMemo(() => avatarUri || bannerUri, [avatarUri, bannerUri]);

    // Memoized themed styles
    const themedStyles = useMemo(() => ({
        container: { paddingTop: insets.top, backgroundColor: theme.colors.background },
        headerActions: { top: insets.top + 6 },
        headerNameOverlay: { top: insets.top + 6 },
        scrollView: { marginTop: minimalistMode ? 0 : HEADER_HEIGHT_NARROWED },
        contentContainer: { paddingTop: minimalistMode ? insets.top + 60 : HEADER_HEIGHT_EXPANDED - insets.top },
        fabStyle: { position: 'absolute' as const, bottom: FAB_BOTTOM_MARGIN + insets.bottom, right: FAB_RIGHT_MARGIN, zIndex: 1000 },
    }), [insets.top, insets.bottom, minimalistMode, theme.colors.background]);

    return (
        <>
            <SEO
                title={t('seo.profile.title', {
                    name: profileDisplayName,
                    username: username,
                    defaultValue: `${profileDisplayName} (@${username}) on Mention`
                })}
                description={profileBio
                    ? t('seo.profile.description', {
                        name: profileDisplayName,
                        bio: profileBio,
                        defaultValue: `View ${profileDisplayName}'s profile on Mention. ${profileBio}`
                    })
                    : t('seo.profile.description', {
                        name: profileDisplayName,
                        bio: '',
                        defaultValue: `View ${profileDisplayName}'s profile on Mention.`
                    })}
                image={profileImage}
                type="profile"
            />
            <View style={[styles.container, themedStyles.container]}>
                <StatusBar barStyle={theme.isDark ? "light-content" : "dark-content"} />

                {loading ? (
                    <ProfileSkeleton theme={theme} />
                ) : (
                    <>
                        {/* Header actions */}
                        <View style={[styles.headerActions, themedStyles.headerActions]}>
                            {!isOwnProfile && (
                                <HeaderIconButton
                                    onPress={toggleSubscription}
                                    disabled={subLoading}
                                >
                                    {subscribed ? (
                                        <BellActive size={20} color={theme.colors.primary} />
                                    ) : (
                                        <Bell size={20} color={theme.colors.text} />
                                    )}
                                </HeaderIconButton>
                            )}
                            <HeaderIconButton>
                                <Search size={20} color={theme.colors.text} />
                            </HeaderIconButton>
                            <HeaderIconButton onPress={handleShare}>
                                <ShareIcon size={20} color={theme.colors.text} />
                            </HeaderIconButton>
                        </View>

                        {/* Name + posts count - disabled animation for performance */}
                        <View
                            style={[
                                styles.headerNameOverlay,
                                themedStyles.headerNameOverlay,
                                {
                                    opacity: 0,
                                    backgroundColor: 'transparent',
                                },
                            ]}
                        >
                            <UserNameComponent
                                name={displayName}
                                verified={profileData?.verified}
                                style={{ name: [styles.headerTitle, { color: theme.colors.text }] }}
                                unifiedColors={true}
                            />
                            <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
                                {t('profile.postsCount', {
                                    count: (profileData as any)?.postCount || 0,
                                    defaultValue: `${(profileData as any)?.postCount || 0} posts`
                                })}
                            </Text>
                        </View>

                        {/* Banner */}
                        {!minimalistMode && (bannerUri ? (
                            <>
                                <ImageBackground
                                    source={{ uri: bannerUri }}
                                    style={[
                                        styles.banner,
                                        {
                                            height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                        },
                                    ]}
                                />
                                <Animated.View
                                    pointerEvents="none"
                                    style={[
                                        styles.banner,
                                        {
                                            height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            right: 0,
                                            zIndex: 1,
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
                                    {
                                        height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                        backgroundColor: `${theme.colors.primary}20`,
                                    },
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

                        {/* Profile content + posts */}
                        <Animated.ScrollView
                            ref={assignProfileScrollRef}
                            showsVerticalScrollIndicator={false}
                            onScroll={onProfileScroll}
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
                            <View style={[styles.profileContent, { backgroundColor: theme.colors.background }, minimalistMode && styles.profileContentMinimalist]}>
                                {minimalistMode ? (
                                    <ProfileHeaderMinimalist
                                        displayName={displayName}
                                        username={profileData?.username}
                                        avatarUri={avatarUri}
                                        verified={profileData?.verified}
                                        isPrivate={isPrivate}
                                        privacySettings={privacySettings}
                                        theme={theme}
                                        UserNameComponent={UserNameComponent}
                                        t={t}
                                    />
                                ) : (
                                    <ProfileHeaderDefault
                                        displayName={displayName}
                                        username={profileData?.username}
                                        avatarUri={avatarUri}
                                        verified={profileData?.verified}
                                        isOwnProfile={isOwnProfile}
                                        currentUsername={currentUser?.username}
                                        profileId={profileData?.id}
                                        theme={theme}
                                        UserNameComponent={UserNameComponent}
                                        FollowButtonComponent={FollowButtonComponent}
                                        showBottomSheet={showBottomSheet}
                                        t={t}
                                    />
                                )}

                                {/* Action buttons for minimalist mode */}
                                {minimalistMode && (
                                    <View style={styles.minimalistActions}>
                                        <ProfileActions
                                            isOwnProfile={isOwnProfile}
                                            currentUsername={currentUser?.username}
                                            profileUsername={profileData?.username}
                                            profileId={profileData?.id}
                                            theme={theme}
                                            FollowButtonComponent={FollowButtonComponent}
                                            showBottomSheet={showBottomSheet}
                                            t={t}
                                        />
                                    </View>
                                )}

                                {!minimalistMode && (
                                    <View>
                                        <UserNameComponent
                                            name={displayName}
                                            handle={profileData?.username}
                                            verified={profileData?.verified}
                                            variant="default"
                                            style={{
                                                name: [styles.profileName, { color: theme.colors.text }],
                                                handle: [styles.profileHandle, { color: theme.colors.textSecondary }],
                                                container: undefined,
                                            }}
                                        />
                                        {isPrivate && <PrivateBadge privacySettings={privacySettings} theme={theme} t={t} />}
                                    </View>
                                )}

                                {!minimalistMode && profileData?.bio && (
                                    <Text style={[styles.profileBio, { color: theme.colors.text }]}>
                                        {profileData.bio}
                                    </Text>
                                )}

                                <View style={styles.profileMeta}>
                                    {profileData?.primaryLocation && (
                                        <View style={styles.metaItem}>
                                            <Ionicons name="location-outline" size={16} color={theme.colors.textSecondary} />
                                            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{profileData.primaryLocation}</Text>
                                        </View>
                                    )}
                                    {profileData?.links && profileData.links.length > 0 && (
                                        <View style={styles.metaItem}>
                                            <View style={{ transform: [{ rotate: '-45deg' }] }}>
                                                <Ionicons name="link-outline" size={16} color={theme.colors.textSecondary} />
                                            </View>
                                            <Text style={[styles.metaText, styles.linkText, { color: theme.colors.primary }]}>{profileData.links[0]}</Text>
                                        </View>
                                    )}
                                    <View style={styles.metaItem}>
                                        <Ionicons name="calendar-outline" size={16} color={theme.colors.textSecondary} />
                                        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                                            {t('profile.joined')} {profileData?.createdAt ? new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}
                                        </Text>
                                    </View>
                                </View>

                                {(!isPrivate || isOwnProfile) && (
                                    <ProfileStats
                                        followingCount={followingCount}
                                        followerCount={followerCount}
                                        profileUsername={profileData?.username}
                                        username={username}
                                        theme={theme}
                                        t={t}
                                    />
                                )}

                                {/* Communities section */}
                                {profileData?.communities && profileData.communities.length > 0 &&
                                    (!isPrivate || isOwnProfile) && (
                                        <ProfileCommunities
                                            communities={profileData.communities}
                                            theme={theme}
                                            t={t}
                                        />
                                    )}
                            </View>

                            {/* Tabs */}
                            <AnimatedTabBar
                                tabs={tabs.map((tabLabel, i) => ({ id: String(i), label: tabLabel }))}
                                activeTabId={String(activeTab)}
                                onTabPress={(id) => {
                                    const index = parseInt(id);
                                    onTabPress(index);
                                }}
                                scrollEnabled={true}
                                instanceId={username || 'default'}
                            />

                            {/* Tab Content */}
                            <ProfileTabs
                                tab={tab}
                                profileId={profileData?.id}
                                isPrivate={isPrivate}
                                isOwnProfile={isOwnProfile}
                                theme={theme}
                                t={t}
                            />
                        </Animated.ScrollView>

                        {/* FAB */}
                        <FloatingActionButton
                            onPress={() => router.push('/compose')}
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
        right: DEFAULT_PADDING,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerNameOverlay: {
        zIndex: 10,
        position: 'absolute',
        left: DEFAULT_PADDING,
        alignItems: 'flex-start',
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
    scrollView: {
        zIndex: 3,
    },
    profileContent: {
        paddingHorizontal: DEFAULT_PADDING,
        paddingBottom: DEFAULT_PADDING,
    },
    avatarRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginTop: -45,
        marginBottom: 10,
    },
    profileContentMinimalist: {
        paddingTop: 0,
        marginTop: 0,
    },
    minimalistHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 16,
        position: 'relative',
        width: '100%',
    },
    minimalistInfo: {
        flex: 1,
        marginRight: 16,
    },
    minimalistActions: {
        marginTop: 12,
        marginBottom: 8,
    },
    minimalistAvatarContainer: {
        position: 'relative',
    },
    avatarMinimalist: {
        width: 70,
        height: 70,
        borderRadius: 35,
        borderWidth: 2,
    },
    verifiedBadgeMinimalist: {
        position: 'absolute',
        left: -6,
        bottom: -2,
        borderRadius: 10,
        padding: 2,
    },
    avatar: {
        width: 90,
        height: 90,
        borderRadius: 45,
        borderWidth: 4,
    },
    profileActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    followButton: {
        paddingHorizontal: 24,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
    },
    followButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    profileName: {
        fontSize: 24,
        fontWeight: 'bold',
        marginTop: 10,
        marginBottom: 4,
    },
    profileHandle: {
        fontSize: 15,
        marginBottom: 12,
    },
    profileBio: {
        fontSize: 15,
        lineHeight: 20,
        marginBottom: 12,
    },
    profileMeta: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 12,
    },
    metaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 16,
        marginBottom: 4,
    },
    metaText: {
        fontSize: 15,
        marginLeft: 4,
    },
    linkText: {
    },
    followStats: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    statItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 20,
    },
    statNumber: {
        fontSize: 15,
        fontWeight: '700',
        marginRight: 4,
    },
    statLabel: {
        fontSize: 15,
    },
    communitiesSection: {
        marginTop: 16,
    },
    communityIconImage: {
        flex: 1,
        overflow: 'hidden',
    },
    communitiesTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: 12,
    },
    communityCard: {
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
    },
    communityHeader: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    communityIcon: {
        width: 100,
        height: 100,
        borderRadius: 8,
        marginRight: 12,
        overflow: 'hidden',
    },
    communityInfo: {
        flex: 1,
    },
    communityName: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 4,
    },
    communityDescription: {
        fontSize: 14,
        lineHeight: 18,
        marginBottom: 8,
    },
    communityMembers: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    memberCount: {
        fontSize: 13,
    },
    viewButtonInCard: {
        backgroundColor: 'transparent',
        paddingHorizontal: 16,
        paddingVertical: 6,
        alignSelf: 'center',
        width: "100%",
        textAlign: "center",
        marginTop: 10
    },
    viewButtonText: {
        fontSize: 15,
        fontWeight: '600',
        textAlign: "center"
    },
    skeletonContainer: {
        flex: 1,
    },
    skeletonContent: {
        paddingHorizontal: DEFAULT_PADDING,
        marginTop: 16,
    },
    skeletonBanner: {
        height: 170,
    },
    skeletonAvatarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -40,
    },
    skeletonMetaRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 12,
        flexWrap: 'wrap',
    },
    skeletonTabs: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderBottomWidth: 1,
    },
    privateIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 12,
        gap: 4,
        marginTop: 4,
        marginBottom: 4,
    },
    privateText: {
        fontSize: 12,
        fontWeight: '500',
    },
    actionButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    settingsButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
    privateProfileMessage: {
        fontSize: 18,
        fontWeight: '600',
        textAlign: 'center',
        marginBottom: 8,
    },
    privateProfileSubtext: {
        fontSize: 14,
        textAlign: 'center',
    },
});

export default MentionProfile;
