import { useTheme } from "@/hooks/useTheme";
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
// BlurView removed — not used after switching to image overlay approach
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
import { useProfileData } from '@/hooks/useProfileData';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { useSharedValue, withTiming } from 'react-native-reanimated';
import { Search } from '@/assets/icons/search-icon';
import { Bell } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import SEO from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { HeaderIconButton } from '@/components/HeaderIconButton';

// Constants for better maintainability and responsive design
const HEADER_HEIGHT_EXPANDED = 120;
const HEADER_HEIGHT_NARROWED = 50;

// Responsive breakpoints following industry standards
const BREAKPOINTS = {
    mobile: 768,
    tablet: 1024,
    desktop: 1200,
} as const;

// Type definitions for better type safety
interface ProfileData {
    id: string;
    username: string;
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
    bannerUrl?: string;
    isPrivate?: boolean;
    [key: string]: any;
}

// Properly typed Follow Button component
interface FollowButtonProps {
    userId: string;
    [key: string]: any;
}

const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);

interface ProfileScreenProps {
    tab?: 'posts' | 'replies' | 'media' | 'videos' | 'likes' | 'reposts';
}

const MentionProfile: React.FC<ProfileScreenProps> = ({ tab = 'posts' }) => {
    const { user: currentUser, oxyServices, showBottomSheet, useFollow } = useOxy();
    const theme = useTheme();

    // Type-safe component references
    const TypedFollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<FollowButtonProps>;
    const TypedUserName = UserName as React.ComponentType<any>;

    let { username: urlUsername } = useLocalSearchParams<{ username: string }>();
    if (urlUsername && urlUsername.startsWith('@')) {
        urlUsername = urlUsername.slice(1);
    }
    const username = urlUsername || '';

    // Determine active tab from route prop
    const tabToIndex = (tabName: string): number => {
        switch (tabName) {
            case 'posts': return 0;
            case 'replies': return 1;
            case 'media': return 2;
            case 'videos': return 3;
            case 'likes': return 4;
            case 'reposts': return 5;
            default: return 0;
        }
    };
    const activeTab = tabToIndex(tab);
    
    // Unified profile data hook - handles Oxy profile + backend settings
    const { data: profileData, loading } = useProfileData(username);
    const {
        scrollY,
        createAnimatedScrollHandler,
        scrollEventThrottle,
        registerScrollable,
    } = useLayoutScroll();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const isWideWeb = Platform.OS === 'web' && width >= BREAKPOINTS.mobile;
    const isTablet = width >= BREAKPOINTS.tablet;
    const isDesktop = width >= BREAKPOINTS.desktop;
    const fabTranslateY = useSharedValue(0);
    const fabHeight = 80; // FAB height + bottom margin

    // Responsive spacing based on screen size
    const responsiveSpacing = useMemo(() => ({
        horizontal: isDesktop ? 32 : isTablet ? 24 : 16,
        vertical: isDesktop ? 24 : isTablet ? 20 : 16,
        headerPadding: isWideWeb ? 24 : 16,
    }), [isDesktop, isTablet, isWideWeb]);

    // Track current feed type for the active tab
    const currentFeedType = useMemo<FeedType>(() => tab as FeedType, [tab]);
    const loadingMoreRef = useRef(false);
    const profileScrollRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
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

    // Disable FAB animation completely for better performance
    // useEffect(() => {
    //     ... FAB animation code disabled ...
    // }, [scrollY, fabTranslateY, fabHeight]);

    // Optimized scroll handler - check less frequently but smoothly
    const lastScrollCheckRef = useRef(0);
    const SCROLL_CHECK_THROTTLE = 250; // Check every 250ms for load more (balanced)
    
    const handleProfileScrollEvent = useCallback((event: any) => {
        const now = Date.now();
        // Throttle load-more checks but allow scroll tracking for animations
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
            if (distanceFromBottom < 400) {
                const uid = profileData?.id;
                if (!uid || loadingMoreRef.current) return;
                const state: any = (usePostsStore as any).getState?.();
                if (!state) return;
                const type = currentFeedType;
                const slice = state?.userFeeds?.[uid]?.[type];
                if (slice && slice.hasMore && !slice.isLoading) {
                    loadingMoreRef.current = true;
                    void (async () => {
                        try {
                            await state.fetchUserFeed(uid, { type, cursor: slice.nextCursor, limit: 20 });
                        } finally {
                            loadingMoreRef.current = false;
                        }
                    })();
                }
            }
        } catch {
            // ignore scroll read errors
        }
    }, [currentFeedType, profileData?.id]);
    const onProfileScroll = useMemo(
        () => createAnimatedScrollHandler(handleProfileScrollEvent),
        [createAnimatedScrollHandler, handleProfileScrollEvent]
    );

    useEffect(() => () => {
        clearProfileRegistration();
    }, [clearProfileRegistration]);

    const {
        followerCount,
        followingCount,
        isLoadingCounts: _isLoadingCounts,
        fetchUserCounts: _fetchUserCounts,
        setFollowerCount: _setFollowerCount,
        setFollowingCount: _setFollowingCount,
    } = (useFollow as any)(profileData?.id);

    // Extract computed values from unified profile data
    const design = profileData?.design;
    const displayName = design?.displayName || '';
    const avatarUri = design?.avatar ? oxyServices.getFileDownloadUrl(design.avatar, 'thumb') : undefined;
    const bannerUri = (design?.coverPhotoEnabled && design?.coverImage)
        ? oxyServices.getFileDownloadUrl(design.coverImage, 'full')
        : undefined;
    const minimalistMode = design?.minimalistMode ?? false;
    const primaryColor = design?.primaryColor || theme.colors.primary;
    const privacySettings = profileData?.privacy;

    const tabs = ['Posts', 'Replies', 'Media', 'Videos', 'Likes', 'Reposts'];

    // Subscription (post notifications) state
    const [subscribed, setSubscribed] = useState<boolean>(false);
    const [subLoading, setSubLoading] = useState<boolean>(false);

    // Load subscription status when profile data is available
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                if (!profileData?.id) return;
                const { subscribed } = await subscriptionService.getStatus(profileData.id);
                if (!cancelled) setSubscribed(!!subscribed);
            } catch {
                // silent fail; keep default false
            }
        };
        load();
        return () => { cancelled = true; };
    }, [profileData?.id]);

    const toggleSubscription = async () => {
        if (!profileData?.id || subLoading) return;
        setSubLoading(true);
        const prev = subscribed;
        setSubscribed(!prev);
        try {
            if (!prev) {
                await subscriptionService.subscribe(profileData.id);
            } else {
                await subscriptionService.unsubscribe(profileData.id);
            }
        } catch {
            // rollback on error
            setSubscribed(prev);
        } finally {
            setSubLoading(false);
        }
    };


    const onTabPress = (index: number) => {
        if (!username) return;
        const tabNames = ['posts', 'replies', 'media', 'videos', 'likes', 'reposts'];
        const tabName = tabNames[index];
        const path = index === 0
            ? `/@${username}`
            : `/@${username}/${tabName}`;
        // Use push to maintain browser history for back button
        // Animation still works because layout route keeps component mounted
        router.push(path as any);
    };

    const handleShare = async () => {
        if (!profileData) return;

        try {
            const shareUrl = `https://mention.earth/@${profileData.username}`;
            const shareMessage = `Check out ${displayName || profileData.username}'s profile on Mention!`;

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: `${displayName || profileData.username} on Mention`
            });
        } catch (error) {
            console.error('Error sharing profile:', error);
        }
    };



    // Header background opacity animation
    const headerBackgroundOpacity = useMemo(() => scrollY.interpolate({
        inputRange: [0, HEADER_HEIGHT_EXPANDED],
        outputRange: [0, 1],
        extrapolate: 'clamp',
    }), [scrollY]);

    const renderTabContent = useCallback(() => {
        if (tab === 'media') {
            return (
                <MediaGrid userId={profileData?.id} />
            );
        }

        if (tab === 'videos') {
            return (
                <VideosGrid userId={profileData?.id} />
            );
        }

        return (
            <Feed
                type={tab as any}
                userId={profileData?.id}
                hideHeader={true}
                scrollEnabled={false}
                contentContainerStyle={{ paddingBottom: 100 }}
                recycleItems={true}
                maintainVisibleContentPosition={true}
            />
        );
    }, [tab, profileData?.id]);

    const ProfileSkeleton: React.FC = () => {
        const pulse = useRef(new Animated.Value(0.5)).current;
        useEffect(() => {
            const anim = Animated.loop(
                Animated.sequence([
                    Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
                    Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
                ])
            );
            anim.start();
            return () => anim.stop();
        }, [pulse]);

        const Shimmer = ({ style }: { style?: any }) => (
            <Animated.View style={[styles.skeletonBlock, style, { opacity: pulse, backgroundColor: theme.colors.backgroundSecondary }]} />
        );

        return (
            <View style={[styles.skeletonContainer, { backgroundColor: theme.colors.background }]}>
                {/* Banner placeholder */}
                <Shimmer style={[styles.skeletonBanner, { backgroundColor: theme.colors.backgroundSecondary }]} />

                <View style={styles.skeletonContent}>
                    {/* Avatar row */}
                    <View style={styles.skeletonAvatarRow}>
                        <Shimmer style={[styles.skeletonAvatar, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.background }]} />
                        <View style={{ flex: 1 }} />
                        <Shimmer style={[styles.skeletonBtn, { backgroundColor: theme.colors.backgroundSecondary }]} />
                        <Shimmer style={[styles.skeletonIconBtn, { backgroundColor: theme.colors.backgroundSecondary }]} />
                    </View>

                    {/* Name + handle */}
                    <Shimmer style={[styles.skeletonLine, { width: '40%', height: 20, backgroundColor: theme.colors.backgroundSecondary }]} />
                    <Shimmer style={[styles.skeletonLine, { width: '30%', marginTop: 8, backgroundColor: theme.colors.backgroundSecondary }]} />

                    {/* Bio lines */}
                    <Shimmer style={[styles.skeletonLine, { width: '90%', marginTop: 12, backgroundColor: theme.colors.backgroundSecondary }]} />
                    <Shimmer style={[styles.skeletonLine, { width: '80%', marginTop: 8, backgroundColor: theme.colors.backgroundSecondary }]} />

                    {/* Meta */}
                    <View style={[styles.skeletonMetaRow]}>
                        <Shimmer style={[styles.skeletonChip, { width: 120, backgroundColor: theme.colors.backgroundSecondary }]} />
                        <Shimmer style={[styles.skeletonChip, { width: 160, backgroundColor: theme.colors.backgroundSecondary }]} />
                        <Shimmer style={[styles.skeletonChip, { width: 180, backgroundColor: theme.colors.backgroundSecondary }]} />
                    </View>

                    {/* Tabs */}
                    <View style={[styles.skeletonTabs, { borderColor: theme.colors.border }]}>
                        {[...Array(5)].map((_, i) => (
                            <Shimmer key={i} style={[styles.skeletonTab, { backgroundColor: theme.colors.backgroundSecondary }]} />
                        ))}
                    </View>
                </View>
            </View>
        );
    };

    // Generate SEO data for profile
    const profileDisplayName = displayName || profileData?.username || username;
    const profileBio = profileData?.bio || '';
    const profileImage = avatarUri || bannerUri;
    const { t: tProfile } = useTranslation();

    return (
        <>
            <SEO
                title={tProfile('seo.profile.title', { 
                    name: profileDisplayName, 
                    username: username,
                    defaultValue: `${profileDisplayName} (@${username}) on Mention`
                })}
                description={profileBio 
                    ? tProfile('seo.profile.description', { 
                        name: profileDisplayName, 
                        bio: profileBio,
                        defaultValue: `View ${profileDisplayName}'s profile on Mention. ${profileBio}`
                    })
                    : tProfile('seo.profile.description', { 
                        name: profileDisplayName, 
                        bio: '',
                        defaultValue: `View ${profileDisplayName}'s profile on Mention.`
                    })}
                image={profileImage}
                type="profile"
            />
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
                <StatusBar barStyle={theme.isDark ? "light-content" : "dark-content"} />

                {loading ? (
                    <ProfileSkeleton />
                ) : (
                    <>
                    {/* Header actions */}
                    <View style={[styles.headerActions, { top: insets.top + 6 }]}>
                        <HeaderIconButton 
                            onPress={toggleSubscription} 
                            disabled={subLoading}
                        >
                            <Bell size={20} color={theme.colors.text} />
                        </HeaderIconButton>
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
                            {
                                top: insets.top + 6,
                                opacity: 0, // Disabled animation
                                backgroundColor: 'transparent', // Ensure transparent background
                            },
                        ]}
                    >
                        <TypedUserName
                            name={displayName}
                            verified={profileData?.verified}
                            style={{ name: [styles.headerTitle, { color: theme.colors.text }] }}
                            unifiedColors={true}
                        />
                        <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
                            {(profileData as any)?.postCount || 0} posts
                        </Text>
                    </View>

                    {/* Banner - simplified: single layer with fade overlay only */}
                    {!minimalistMode && (bannerUri ? (
                        <>
                            {/* Base banner image - no transform for better performance */}
                            <ImageBackground
                                source={{ uri: bannerUri }}
                                style={[
                                    styles.banner,
                                    {
                                        height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                    },
                                ]}
                            />
                            {/* Background overlay - animated on scroll */}
                            <Animated.View
                                pointerEvents={'none' as any}
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
                            {/* Overlay - animated on scroll */}
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
                    {/* Optimized ScrollView - Instagram/Twitter-level smoothness */}
                    <Animated.ScrollView
                        ref={assignProfileScrollRef}
                        showsVerticalScrollIndicator={false}
                        onScroll={onProfileScroll}
                        scrollEventThrottle={16} // 60fps smooth scrolling like Instagram/Twitter
                        style={[styles.scrollView, { marginTop: minimalistMode ? 0 : HEADER_HEIGHT_NARROWED }]}
                        contentContainerStyle={{ paddingTop: minimalistMode ? insets.top + 60 : HEADER_HEIGHT_EXPANDED - insets.top }}
                        stickyHeaderIndices={[1]} // Tab bar is sticky (index 1: profile info is 0, tabs are 1)
                        nestedScrollEnabled={false} // Disabled nested scrolling for performance
                        removeClippedSubviews={Platform.OS !== 'web'}
                        disableIntervalMomentum={true}
                        decelerationRate="normal" // Smooth deceleration
                        {...(Platform.OS === 'web' ? { 'data-layoutscroll': 'true' } : {})}
                    >
                            {/* Profile info */}
                            <View style={[styles.profileContent, { backgroundColor: theme.colors.background }, minimalistMode && styles.profileContentMinimalist]}>
                                {minimalistMode ? (
                                    // Minimalist layout: horizontal with avatar on right
                                    <View style={styles.minimalistHeader}>
                                        <View style={styles.minimalistInfo}>
                                            <TypedUserName
                                                name={displayName}
                                                handle={profileData?.username}
                                                verified={false}
                                                variant="default"
                                                style={{ name: [styles.profileName, { color: theme.colors.text }], handle: [styles.profileHandle, { color: theme.colors.textSecondary }], container: undefined } as any}
                                            />
                                            {(() => {
                                                const isPrivate = profileData?.privacySettings?.isPrivateAccount || 
                                                                 privacySettings?.profileVisibility === 'private' ||
                                                                 privacySettings?.profileVisibility === 'followers_only';
                                                if (isPrivate) {
                                                    return (
                                                        <View style={styles.privateIndicator}>
                                                            <Ionicons name="lock-closed" size={12} color={theme.colors.textSecondary} />
                                                            <Text style={[styles.privateText, { color: theme.colors.textSecondary }]}>
                                                                {privacySettings?.profileVisibility === 'followers_only' 
                                                                    ? tProfile('settings.privacy.followersOnly') 
                                                                    : tProfile('settings.privacy.private')}
                                                            </Text>
                                                        </View>
                                                    );
                                                }
                                                return null;
                                            })()}
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
                                            {profileData?.verified && (
                                                <View style={[styles.verifiedBadgeMinimalist, { backgroundColor: theme.colors.background }]}>
                                                    <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                                                </View>
                                            )}
                                        </View>
                                    </View>
                                ) : (
                                    // Default layout: avatar overlapping banner
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
                                        {currentUser?.username === username ? (
                                            <View style={styles.actionButtons}>
                                                <TouchableOpacity
                                                    style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
                                                    onPress={() => showBottomSheet?.('EditProfile')}
                                                >
                                                    <Text style={styles.followButtonText}>Edit Profile</Text>
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
                                        ) : profileData?.id ? (
                                            <TypedFollowButton userId={profileData.id} />
                                        ) : null}
                                    </View>
                                </View>
                                )}

                                {/* Action buttons for minimalist mode */}
                                {minimalistMode && (
                                    <View style={styles.minimalistActions}>
                                        {currentUser?.username === username ? (
                                            <View style={styles.actionButtons}>
                                                <TouchableOpacity
                                                    style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
                                                    onPress={() => showBottomSheet?.('EditProfile')}
                                                >
                                                    <Text style={styles.followButtonText}>Edit Profile</Text>
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
                                        ) : profileData?.id ? (
                                            <TypedFollowButton userId={profileData.id} />
                                        ) : null}
                                    </View>
                                )}

                                {!minimalistMode && (
                                    <View>
                                    <TypedUserName
                                        name={displayName}
                                        handle={profileData?.username}
                                        verified={profileData?.verified}
                                        variant="default"
                                        style={{ name: [styles.profileName, { color: theme.colors.text }], handle: [styles.profileHandle, { color: theme.colors.textSecondary }], container: undefined } as any}
                                    />
                                    {(() => {
                                        // Check both old structure (privacySettings.isPrivateAccount) and new structure (privacySettings.profileVisibility)
                                        const isPrivate = profileData?.privacySettings?.isPrivateAccount || 
                                                         privacySettings?.profileVisibility === 'private' ||
                                                         privacySettings?.profileVisibility === 'followers_only';
                                        if (isPrivate) {
                                            return (
                                                <View style={styles.privateIndicator}>
                                                    <Ionicons name="lock-closed" size={12} color={theme.colors.textSecondary} />
                                                    <Text style={[styles.privateText, { color: theme.colors.textSecondary }]}>
                                                        {privacySettings?.profileVisibility === 'followers_only' 
                                                            ? tProfile('settings.privacy.followersOnly') 
                                                            : tProfile('settings.privacy.private')}
                                                    </Text>
                                                </View>
                                            );
                                        }
                                        return null;
                                    })()}
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
                                            <View
                                                style={{
                                                    transform: [{ rotate: '-45deg' }],
                                                }}
                                            >
                                                <Ionicons name="link-outline" size={16} color={theme.colors.textSecondary} />
                                            </View>
                                            <Text style={[styles.metaText, styles.linkText, { color: theme.colors.primary }]}>{profileData.links[0]}</Text>
                                        </View>
                                    )}
                                    <View style={styles.metaItem}>
                                        <Ionicons name="calendar-outline" size={16} color={theme.colors.textSecondary} />
                                        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>Joined {profileData?.createdAt ? new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}</Text>
                                    </View>
                                </View>

                                {(() => {
                                    const isPrivate = profileData?.privacySettings?.isPrivateAccount || 
                                                     privacySettings?.profileVisibility === 'private' ||
                                                     privacySettings?.profileVisibility === 'followers_only';
                                    return (!isPrivate || currentUser?.username === username);
                                })() && (
                                    <View style={styles.followStats}>
                                        <TouchableOpacity
                                            style={styles.statItem}
                                            onPress={() => router.push(`/@${profileData?.username || username}/following` as any)}
                                        >
                                            <Text style={[styles.statNumber, { color: theme.colors.text }]}>
                                                {followingCount ?? 0}
                                            </Text>
                                            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Following</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={styles.statItem}
                                            onPress={() => router.push(`/@${profileData?.username || username}/followers` as any)}
                                        >
                                            <Text style={[styles.statNumber, { color: theme.colors.text }]}>
                                                {followerCount ?? 0}
                                            </Text>
                                            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Followers</Text>
                                        </TouchableOpacity>
                                    </View>
                                )}

                                {/* Communities section */}
                                {profileData?.communities && profileData.communities.length > 0 &&
                                    (!profileData?.privacySettings?.isPrivateAccount || currentUser?.username === username) && (
                                        <View style={styles.communitiesSection}>
                                            <Text style={[styles.communitiesTitle, { color: theme.colors.text }]}>Communities</Text>
                                            {profileData.communities.map((community: any, index: number) => (
                                                <View key={community.id || index} style={[styles.communityCard, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                                                    <View style={styles.communityHeader}>
                                                        {community.icon && (
                                                            <View style={styles.communityIcon}>
                                                                <Image
                                                                    source={{ uri: community.icon }}
                                                                    resizeMode="cover"
                                                                    style={styles.communityIconImage as any}
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
                                                                        {community.memberCount} Members
                                                                    </Text>
                                                                </View>
                                                            )}
                                                        </View>
                                                    </View>
                                                    <TouchableOpacity style={styles.viewButtonInCard}>
                                                        <Text style={[styles.viewButtonText, { color: theme.colors.primary }]}>View</Text>
                                                    </TouchableOpacity>
                                                </View>
                                            ))}
                                        </View>
                                    )}
                            </View>

                            {/* Tabs */}
                            <AnimatedTabBar
                                tabs={tabs.map((tab, i) => ({ id: String(i), label: tab }))}
                                activeTabId={String(activeTab)}
                                onTabPress={(id) => {
                                    const index = parseInt(id);
                                    onTabPress(index);
                                }}
                                scrollEnabled={true}
                                instanceId={username || 'default'}
                            />

                            {/* Tab Content */}
                            {renderTabContent()}
                    </Animated.ScrollView>

                    {/* FAB - rendered after ScrollView to ensure visibility */}
                    <FloatingActionButton
                        onPress={() => router.push('/compose')}
                        animatedTranslateY={fabTranslateY}
                        style={{ position: 'absolute', bottom: 24 + insets.bottom, right: 24, zIndex: 1000 }}
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
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerNameOverlay: {
        zIndex: 10,
        position: 'absolute',
        left: 16,
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
    profileContainer: {
    },
    profileContent: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    avatarRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginTop: -45,
        marginBottom: 10,
    },
    avatarRowMinimalist: {
        marginTop: 0,
        marginBottom: 16,
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
    notificationButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        borderWidth: 1,
        // borderColor will be set inline with theme
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
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
    followedBy: {
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
    communityIconGradient: {
        flex: 1,
        borderRadius: 8,
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
    memberAvatars: {
        flexDirection: 'row',
        marginRight: 8,
    },
    memberAvatar: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        // borderColor will be set inline with theme
    },
    avatarCircle: {
        flex: 1,
        // backgroundColor will be set inline with theme
        borderRadius: 10,
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
    skeletonTab: {
        flex: 1,
        height: 28,
        borderRadius: 14,
    },
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    stickyTabBarContent: {
        flexDirection: 'row',
        borderBottomWidth: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    // Skeleton styles
    skeletonContainer: {
        flex: 1,
    },
    skeletonContent: {
        paddingHorizontal: 16,
        marginTop: 16,
    },
    skeletonBanner: {
        height: 170, // HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED
    },
    skeletonAvatarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -40,
    },
    skeletonAvatar: {
        width: 96,
        height: 96,
        borderRadius: 48,
        borderWidth: 2,
    },
    skeletonBtn: {
        width: 120,
        height: 36,
        borderRadius: 18,
        marginRight: 8,
    },
    skeletonIconBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    skeletonBlock: {
        borderRadius: 8,
    },
    skeletonLine: {
        height: 14,
        borderRadius: 7,
    },
    skeletonMetaRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 12,
        flexWrap: 'wrap',
    },
    skeletonChip: {
        height: 20,
        borderRadius: 10,
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

});

export default MentionProfile;
