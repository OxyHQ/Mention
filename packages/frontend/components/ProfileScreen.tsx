import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef, useState, useEffect, useMemo } from 'react';
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
import Avatar from '@/components/Avatar';
import UserName from './UserName';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useOxy } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { Feed } from './Feed/index';
import { colors } from '../styles/colors';
import { useAppearanceStore } from '@/store/appearanceStore';
import { subscriptionService } from '@/services/subscriptionService';

// Constants for better maintainability and responsive design
const HEADER_HEIGHT_EXPANDED = 120;
const HEADER_HEIGHT_NARROWED = 50;
const FAB_POSITION_BOTTOM = 20;
const FAB_POSITION_RIGHT = 20;

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

const MentionProfile: React.FC = () => {
    const { user: currentUser, oxyServices, showBottomSheet, useFollow } = useOxy();
    
    // Type-safe component references
    const TypedFollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<FollowButtonProps>;
    const TypedUserName = UserName as React.ComponentType<any>;
    
    let { username } = useLocalSearchParams<{ username: string }>();
    if (username && username.startsWith('@')) {
        username = username.slice(1);
    }

    const [activeTab, setActiveTab] = useState<number>(0);
    const { byUserId, loadForUser } = useAppearanceStore();
    const [profileData, setProfileData] = useState<ProfileData | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const layoutScroll = useLayoutScroll();
    // Always use the global scrollY from the app's LayoutScrollProvider so
    // profile animations share the single source of truth and don't retain
    // local scroll state between mounts.
    const scrollY = layoutScroll.scrollY;
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const isWideWeb = Platform.OS === 'web' && width >= BREAKPOINTS.mobile;
    const isTablet = width >= BREAKPOINTS.tablet;
    const isDesktop = width >= BREAKPOINTS.desktop;

    // Responsive spacing based on screen size
    const responsiveSpacing = useMemo(() => ({
        horizontal: isDesktop ? 32 : isTablet ? 24 : 16,
        vertical: isDesktop ? 24 : isTablet ? 20 : 16,
        headerPadding: isWideWeb ? 24 : 16,
    }), [isDesktop, isTablet, isWideWeb]);

    // Improved FAB positioning with better responsive design
    const fabPositionStyle = useMemo(() => ({
        ...(isWideWeb 
            ? {
                // Sticky layout for wide web viewports
                position: 'sticky' as const,
                bottom: responsiveSpacing.vertical,
                right: responsiveSpacing.horizontal,
                marginLeft: 'auto',
                marginRight: FAB_POSITION_RIGHT,
                marginBottom: FAB_POSITION_BOTTOM,
            }
            : {
                // Absolute positioning for smaller screens / native
                position: 'absolute' as const,
                right: FAB_POSITION_RIGHT,
                bottom: FAB_POSITION_BOTTOM,
            }
        )
    }), [isWideWeb, responsiveSpacing]);

    // Fetch profile data
    useEffect(() => {
        const fetchProfileData = async () => {
            if (!username) {
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                const data = await oxyServices.getProfileByUsername(username);
                console.log('Fetched profile data:', data);
                setProfileData(data);
            } catch (error) {
                console.error('Error fetching profile data:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchProfileData();
    }, [username, oxyServices]);

    const {
        followerCount,
        followingCount,
        isLoadingCounts: _isLoadingCounts,
        fetchUserCounts: _fetchUserCounts,
        setFollowerCount: _setFollowerCount,
        setFollowingCount: _setFollowingCount,
    } = (useFollow as any)(profileData?.id);

    const avatarUri = profileData?.avatar ? oxyServices.getFileDownloadUrl(profileData.avatar as string, 'thumb') : undefined;

    // Load appearance settings for this profile's oxy user id
    useEffect(() => {
        if (profileData?.id) {
            loadForUser(profileData.id);
        }
    }, [profileData?.id, loadForUser]);

    const userAppearance = profileData?.id ? byUserId[profileData.id] : undefined;
    const primaryColor = userAppearance?.appearance?.primaryColor || colors.primaryColor;
    const bannerUri = userAppearance?.profileHeaderImage
        ? oxyServices.getFileDownloadUrl(userAppearance.profileHeaderImage, 'full')
        : undefined;

    const tabs = ['Posts', 'Replies', 'Media', 'Likes', 'Reposts'];

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
        setActiveTab(index);
    };

    const handleShare = async () => {
        if (!profileData) return;

        try {
            const shareUrl = `https://mention.earth/@${profileData.username}`;
            const shareMessage = `Check out ${profileData.name?.full || profileData.username}'s profile on Mention!`;

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: `${profileData.name?.full || profileData.username} on Mention`
            });
        } catch (error) {
            console.error('Error sharing profile:', error);
        }
    };



    const renderTabContent = () => {
        const feedType = activeTab === 0 ? 'posts' : activeTab === 1 ? 'replies' : activeTab === 2 ? 'media' : activeTab === 3 ? 'likes' : 'reposts';

        return (
            <Feed
                type={feedType as any}
                userId={profileData?.id}
                hideHeader={true}
                scrollEnabled={false}
                contentContainerStyle={{ paddingBottom: 100 }}
                recycleItems={true}
                maintainVisibleContentPosition={true}
            />
        );
    };

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
            <Animated.View style={[styles.skeletonBlock, style, { opacity: pulse }]} />
        );

        return (
            <View style={styles.skeletonContainer}>
                {/* Banner placeholder */}
                <Shimmer style={[styles.skeletonBanner]} />

                <View style={styles.skeletonContent}>
                    {/* Avatar row */}
                    <View style={styles.skeletonAvatarRow}>
                        <Shimmer style={styles.skeletonAvatar} />
                        <View style={{ flex: 1 }} />
                        <Shimmer style={styles.skeletonBtn} />
                        <Shimmer style={styles.skeletonIconBtn} />
                    </View>

                    {/* Name + handle */}
                    <Shimmer style={[styles.skeletonLine, { width: '40%', height: 20 }]} />
                    <Shimmer style={[styles.skeletonLine, { width: '30%', marginTop: 8 }]} />

                    {/* Bio lines */}
                    <Shimmer style={[styles.skeletonLine, { width: '90%', marginTop: 12 }]} />
                    <Shimmer style={[styles.skeletonLine, { width: '80%', marginTop: 8 }]} />

                    {/* Meta */}
                    <View style={[styles.skeletonMetaRow]}>
                        <Shimmer style={[styles.skeletonChip, { width: 120 }]} />
                        <Shimmer style={[styles.skeletonChip, { width: 160 }]} />
                        <Shimmer style={[styles.skeletonChip, { width: 180 }]} />
                    </View>

                    {/* Tabs */}
                    <View style={styles.skeletonTabs}>
                        {[...Array(5)].map((_, i) => (
                            <Shimmer key={i} style={styles.skeletonTab} />
                        ))}
                    </View>
                </View>
            </View>
        );
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <StatusBar barStyle="light-content" />

            {loading ? (
                <ProfileSkeleton />
            ) : (
                <>
                    {/* Back button */}
                    <View style={[styles.backButton, { top: insets.top + 5 }]}>
                        <TouchableOpacity onPress={() => router.back()}>
                            <Ionicons name="arrow-back" size={20} color={colors.primaryLight} />
                        </TouchableOpacity>
                    </View>

                    {/* Header actions */}
                    <View style={[styles.headerActions, { top: insets.top + 5 }]}>
                        <TouchableOpacity style={styles.headerIconButton} onPress={toggleSubscription} disabled={subLoading}>
                            <Ionicons name={subscribed ? 'notifications' : 'notifications-outline'} size={20} color={colors.primaryLight} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="search-outline" size={20} color={colors.primaryLight} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton} onPress={handleShare}>
                            <Ionicons name="share-outline" size={20} color={colors.primaryLight} />
                        </TouchableOpacity>
                    </View>

                    {/* Name + posts count */}
                    <Animated.View
                        style={[
                            styles.headerNameOverlay,
                            {
                                top: insets.top + 6,
                                opacity: scrollY.interpolate({
                                    inputRange: [-50, 80, 120],
                                    outputRange: [0, 0, 1],
                                    extrapolate: 'clamp',
                                }),
                                transform: [
                                    {
                                        translateY: scrollY.interpolate({
                                            inputRange: [-50, 100, 180],
                                            outputRange: [0, 200, 0],
                                            extrapolate: 'clamp',
                                        }),
                                    },
                                ],
                            },
                        ]}
                    >
                        <TypedUserName
                            name={profileData?.name?.full || profileData?.username}
                            verified={profileData?.verified}
                            style={{ name: styles.headerTitle }}
                            unifiedColors={true}
                        />
                        <Text style={styles.headerSubtitle}>
                            {(profileData as any)?.postCount || 0} posts
                        </Text>
                    </Animated.View>

                    {/* Banner */}
                    {bannerUri ? (
                        <AnimatedImageBackground
                            source={{ uri: bannerUri }}
                            style={[
                                styles.banner,
                                {
                                    height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                    transform: [
                                        {
                                            scale: scrollY.interpolate({
                                                inputRange: [-150, 0],
                                                outputRange: [1.5, 1],
                                                extrapolateLeft: 'extend',
                                                extrapolateRight: 'clamp',
                                            }),
                                        },
                                    ],
                                },
                            ]}
                        >
                            {/* Cross-platform blur overlay: Animated Image (native blurRadius) or CSS filter (web) */}
                            {/* Blurred overlay: shows only when scrolled — native uses blurRadius, web uses CSS filter */}
                            <AnimatedImageBackground
                                source={{ uri: bannerUri }}
                                // native blurRadius prop applied directly; for web we'll use imageStyle filter
                                blurRadius={Platform.OS === 'web' ? 0 : 12}
                                imageStyle={Platform.OS === 'web' ? ({
                                    // @ts-ignore: web-only styles
                                    WebkitFilter: 'blur(8px)',
                                    // @ts-ignore: web-only styles
                                    filter: 'blur(8px)',
                                    width: '110%',
                                    height: '110%',
                                    transform: [{ scale: 1.05 }],
                                } as any) : undefined}
                                style={[
                                    StyleSheet.absoluteFillObject,
                                    {
                                        zIndex: 2,
                                        opacity: scrollY.interpolate({
                                            inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                            outputRange: [0, 1],
                                            extrapolate: 'clamp',
                                        }) as any,
                                    } as any,
                                ]}
                            />

                            {/* Dark overlay: make the banner darker as you scroll */}
                            <Animated.View
                                pointerEvents={'none' as any}
                                style={[
                                    StyleSheet.absoluteFillObject,
                                    {
                                        zIndex: 3,
                                        backgroundColor: 'rgba(0,0,0,0.6)',
                                        opacity: scrollY.interpolate({
                                            inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                            outputRange: [0, 0.6],
                                            extrapolate: 'clamp',
                                        }) as any,
                                    },
                                ]}
                            />
                        </AnimatedImageBackground>
                    ) : (
                        <Animated.View
                            style={[
                                styles.banner,
                                {
                                    height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                    backgroundColor: `${colors.primaryColor}20`,
                                    transform: [
                                        {
                                            scale: scrollY.interpolate({
                                                inputRange: [-150, 0],
                                                outputRange: [1.5, 1],
                                                extrapolateLeft: 'extend',
                                                extrapolateRight: 'clamp',
                                            }),
                                        },
                                    ],
                                },
                            ]}
                        >
                            {/* Overlay that fades in to the normal primary color as you scroll */}
                            <Animated.View
                                style={[
                                    StyleSheet.absoluteFillObject,
                                    {
                                        backgroundColor: primaryColor,
                                        opacity: scrollY.interpolate({
                                            inputRange: [-50, 0, 100],
                                            outputRange: [0, 0, 1],
                                            extrapolate: 'clamp',
                                        }),
                                    },
                                ]}
                            />
                        </Animated.View>
                    )}

                    {/* Profile content + posts */}
                    {/* ScrollView with stickyHeaderIndices */}
                    <Animated.ScrollView
                        showsVerticalScrollIndicator={false}
                        onScroll={Animated.event(
                            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                            { useNativeDriver: false }
                        )}
                        scrollEventThrottle={16}
                        style={[styles.scrollView, { marginTop: HEADER_HEIGHT_NARROWED }]}
                        contentContainerStyle={{ paddingTop: HEADER_HEIGHT_EXPANDED - insets.top }}
                        stickyHeaderIndices={[1]}
                    >
                        {/* Profile info */}
                        <View style={styles.profileContent}>
                            <View style={styles.avatarRow}>
                                <Avatar
                                    source={avatarUri}
                                    size={80}
                                    useAnimated
                                    style={[styles.avatar, {
                                        transform: [
                                            {
                                                scale: scrollY.interpolate({
                                                    inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                                    outputRange: [1, 0.7],
                                                    extrapolate: 'clamp',
                                                }),
                                            },
                                            {
                                                translateY: scrollY.interpolate({
                                                    inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                                    outputRange: [0, 16],
                                                    extrapolate: 'clamp',
                                                }),
                                            },
                                        ],
                                    }]}
                                    imageStyle={{
                                    }}
                                />

                                <View style={styles.profileActions}>
                                    {currentUser?.username === username ? (
                                        <View style={styles.actionButtons}>
                                            <TouchableOpacity
                                                style={styles.followButton}
                                                onPress={() => showBottomSheet?.('EditProfile')}
                                            >
                                                <Text style={styles.followButtonText}>Edit Profile</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={styles.settingsButton}
                                                onPress={() => showBottomSheet?.('PrivacySettings')}
                                            >
                                                <Ionicons name="settings-outline" size={20} color={colors.primaryDark} />
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={styles.settingsButton}
                                                onPress={() => router.push('/settings/appearance')}
                                            >
                                                <Ionicons name="color-palette-outline" size={20} color={colors.primaryDark} />
                                            </TouchableOpacity>
                                        </View>
                                    ) : profileData?.id ? (
                                        <TypedFollowButton userId={profileData.id} />
                                    ) : null}
                                </View>
                            </View>

                            <View>
                                <TypedUserName
                                    name={profileData?.name?.full || profileData?.username}
                                    handle={profileData?.username}
                                    verified={profileData?.verified}
                                    variant="default"
                                    style={{ name: styles.profileName, handle: styles.profileHandle, container: undefined } as any}
                                />
                                {profileData?.privacySettings?.isPrivateAccount && (
                                    <View style={styles.privateIndicator}>
                                        <Ionicons name="lock-closed" size={12} color="#666" />
                                        <Text style={styles.privateText}>Private</Text>
                                    </View>
                                )}
                            </View>
                            {profileData?.bio && (
                                <Text style={styles.profileBio}>
                                    {profileData.bio}
                                </Text>
                            )}

                            <View style={styles.profileMeta}>
                                {profileData?.primaryLocation && (
                                    <View style={styles.metaItem}>
                                        <Ionicons name="location-outline" size={16} color="#666" />
                                        <Text style={styles.metaText}>{profileData.primaryLocation}</Text>
                                    </View>
                                )}
                                {profileData?.links && profileData.links.length > 0 && (
                                    <View style={styles.metaItem}>
                                        <View
                                            style={{
                                                transform: [{ rotate: '-45deg' }],
                                            }}
                                        >
                                            <Ionicons name="link-outline" size={16} color="#666" />
                                        </View>
                                        <Text style={[styles.metaText, styles.linkText]}>{profileData.links[0]}</Text>
                                    </View>
                                )}
                                <View style={styles.metaItem}>
                                    <Ionicons name="calendar-outline" size={16} color="#666" />
                                    <Text style={styles.metaText}>Joined {profileData?.createdAt ? new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}</Text>
                                </View>
                            </View>

                            {(!profileData?.privacySettings?.isPrivateAccount || currentUser?.username === username) && (
                                <View style={styles.followStats}>
                                    <TouchableOpacity
                                        style={styles.statItem}
                                        onPress={() => router.push(`/@${profileData?.username || username}/following`)}
                                    >
                                        <Text style={styles.statNumber}>
                                            {followingCount ?? 0}
                                        </Text>
                                        <Text style={styles.statLabel}>Following</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.statItem}
                                        onPress={() => router.push(`/@${profileData?.username || username}/followers`)}
                                    >
                                        <Text style={styles.statNumber}>
                                            {followerCount ?? 0}
                                        </Text>
                                        <Text style={styles.statLabel}>Followers</Text>
                                    </TouchableOpacity>
                                </View>
                            )}

                            {/* Communities section */}
                            {profileData?.communities && profileData.communities.length > 0 &&
                                (!profileData?.privacySettings?.isPrivateAccount || currentUser?.username === username) && (
                                    <View style={styles.communitiesSection}>
                                        <Text style={styles.communitiesTitle}>Communities</Text>
                                        {profileData.communities.map((community: any, index: number) => (
                                            <View key={community.id || index} style={styles.communityCard}>
                                                <View style={styles.communityHeader}>
                                                    {community.icon && (
                                                        <View style={styles.communityIcon}>
                                                            <Image
                                                                source={{ uri: community.icon }}
                                                                style={styles.communityIconImage as any}
                                                            />
                                                        </View>
                                                    )}
                                                    <View style={styles.communityInfo}>
                                                        <Text style={styles.communityName}>{community.name}</Text>
                                                        {community.description && (
                                                            <Text style={styles.communityDescription}>
                                                                {community.description}
                                                            </Text>
                                                        )}
                                                        {community.memberCount && (
                                                            <View style={styles.communityMembers}>
                                                                <Text style={styles.memberCount}>
                                                                    {community.memberCount} Members
                                                                </Text>
                                                            </View>
                                                        )}
                                                    </View>
                                                </View>
                                                <TouchableOpacity style={styles.viewButtonInCard}>
                                                    <Text style={styles.viewButtonText}>View</Text>
                                                </TouchableOpacity>
                                            </View>
                                        ))}
                                    </View>
                                )}
                        </View>

                        {/* Tabs */}
                        <View style={styles.tabBarContainer}>
                            <View style={styles.tabBar}>
                                {tabs.map((tab, i) => (
                                    <TouchableOpacity
                                        key={tab}
                                        style={styles.tab}
                                        onPress={() => onTabPress(i)}
                                    >
                                        <Text
                                            style={[
                                                styles.tabText,
                                                activeTab === i && { color: primaryColor, fontWeight: '700' },
                                            ]}
                                        >
                                            {tab}
                                        </Text>
                                        {activeTab === i && <View style={[styles.tabIndicator, { backgroundColor: primaryColor }]} />}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>

                        {/* Tab Content */}
                        {renderTabContent()}
                    </Animated.ScrollView>


                    {/* FAB */}
                    <TouchableOpacity
                        style={[styles.fab, fabPositionStyle as any]}
                        onPress={() => router.push('/compose')}
                    >
                        <Ionicons name="add" size={24} color="#FFF" />
                    </TouchableOpacity>
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    backButton: {
        zIndex: 2,
        position: 'absolute',
        left: 12,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        height: 36,
        width: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerActions: {
        zIndex: 2,
        position: 'absolute',
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
    },
    headerIconButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 4,
    },
    headerNameOverlay: {
        zIndex: 2,
        position: 'absolute',
        left: 60,
        alignItems: 'flex-start',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.primaryLight,
        marginBottom: -3,
    },
    headerSubtitle: {
        fontSize: 13,
        color: colors.primaryLight,
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
        backgroundColor: colors.primaryLight,
    },
    avatarRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginTop: -30,
        marginBottom: 10,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        borderWidth: 3,
        borderColor: colors.COLOR_BLACK_LIGHT_9,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
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
        borderColor: '#2F3336',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
    },
    followButton: {
        paddingHorizontal: 24,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    followButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    profileName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginTop: 10,
        marginBottom: 4,
    },
    profileHandle: {
        fontSize: 15,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginBottom: 12,
    },
    profileBio: {
        fontSize: 15,
        color: colors.COLOR_BLACK_LIGHT_1,
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
        color: colors.COLOR_BLACK_LIGHT_4,
        marginLeft: 4,
    },
    linkText: {
        color: colors.primaryColor,
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
        color: colors.COLOR_BLACK_LIGHT_1,
        marginRight: 4,
    },
    statLabel: {
        fontSize: 15,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    followedBy: {
        fontSize: 15,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    tabBarContainer: {
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    tabBar: {
        flexDirection: 'row',
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    tab: {
        flex: 1,
        paddingVertical: 16,
        alignItems: 'center',
        position: 'relative',
    },
    tabText: {
        fontSize: 15,
        fontWeight: '500',
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: '700',
    },
    tabIndicator: {
        position: 'absolute',
        bottom: 0,
        width: 30,
        height: 2,
        backgroundColor: colors.primaryColor,
        borderRadius: 1,
    },

    communitiesSection: {
        marginTop: 16,
    },
    communityIconImage: {
        flex: 1,
        overflow: 'hidden',
        resizeMode: 'cover',
    },
    communitiesTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#FFF',
        marginBottom: 12,
    },
    communityCard: {
        backgroundColor: '#16181C',
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#2F3336',
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
        backgroundColor: '#1D9BF0',
        borderRadius: 8,
    },
    communityInfo: {
        flex: 1,
    },
    communityName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#FFF',
        marginBottom: 4,
    },
    communityDescription: {
        fontSize: 14,
        color: '#71767B',
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
        borderColor: '#16181C',
    },
    avatarCircle: {
        flex: 1,
        backgroundColor: '#71767B',
        borderRadius: 10,
    },
    memberCount: {
        fontSize: 13,
        color: '#71767B',
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
        color: colors.primaryColor,
        fontSize: 15,
        fontWeight: '600',
        textAlign: "center"
    },
    fab: {
        bottom: 20,
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        zIndex: 1000,
        backgroundColor: colors.primaryColor,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },

    stickyTabBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 1000,
    },
    stickyTabBarContent: {
        flexDirection: 'row',
        backgroundColor: '#000',
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
    },
    // Skeleton styles
    skeletonContainer: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    skeletonContent: {
        paddingHorizontal: 16,
        marginTop: 16,
    },
    skeletonBanner: {
        height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
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
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderWidth: 2,
        borderColor: colors.COLOR_BLACK_LIGHT_9,
    },
    skeletonBtn: {
        width: 120,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        marginRight: 8,
    },
    skeletonIconBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    skeletonBlock: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderRadius: 8,
    },
    skeletonLine: {
        height: 14,
        borderRadius: 7,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
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
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    skeletonTabs: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    skeletonTab: {
        flex: 1,
        height: 28,
        borderRadius: 14,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    privateIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 12,
        gap: 4,
    },
    privateText: {
        color: '#666',
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
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },

});

export default MentionProfile;
