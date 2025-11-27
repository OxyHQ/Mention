import React, { useMemo, useCallback, useState, useEffect } from 'react';
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
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { usePostsStore } from '@/stores/postsStore';
import type { FeedType } from '@mention/shared-types';

// Icons
import { Search } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';

// Components
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { HeaderIconButton } from '@/components/HeaderIconButton';
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
    const { user: currentUser, oxyServices, showBottomSheet, useFollow } = useOxy();
    const theme = useTheme();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

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
    const { followerCount = 0, followingCount = 0 } = (
        useFollow as (userId: string) => { followerCount?: number; followingCount?: number }
    )(stableUserId);

    // Subscription handling
    const { subscribed, loading: subLoading, toggle: toggleSubscription } = useSubscription(
        profileData?.id,
        currentUser?.id,
        currentUser?.id === profileData?.id
    );

    // Computed values
    const design = profileData?.design;
    const displayName = design?.displayName || '';
    const avatarUri = design?.avatar
        ? oxyServices.getFileDownloadUrl(design.avatar, 'thumb')
        : undefined;
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
                                <HeaderIconButton onPress={toggleSubscription} disabled={subLoading}>
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

                        {/* Header name overlay (hidden by default) */}
                        <View
                            style={[
                                styles.headerNameOverlay,
                                themedStyles.headerNameOverlay,
                                styles.headerNameOverlayHidden,
                            ]}
                        >
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

                        {/* Banner */}
                        {!minimalistMode &&
                            (bannerUri ? (
                                <>
                                    <ImageBackground
                                        source={{ uri: bannerUri }}
                                        style={[styles.banner, styles.bannerHeight]}
                                    />
                                    <Animated.View
                                        pointerEvents="none"
                                        style={[
                                            styles.banner,
                                            styles.bannerHeight,
                                            styles.bannerOverlay,
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
        right: LAYOUT.DEFAULT_PADDING,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerNameOverlay: {
        zIndex: 10,
        position: 'absolute',
        left: LAYOUT.DEFAULT_PADDING,
        alignItems: 'flex-start',
    },
    headerNameOverlayHidden: {
        opacity: 0,
        backgroundColor: 'transparent',
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
});

export default MentionProfile;
