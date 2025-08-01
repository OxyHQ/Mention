import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef, useState, useEffect } from 'react';
import {
    Animated,
    Image,
    ImageBackground,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Share
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy, FollowButton } from '@oxyhq/services';
import { Feed, PostItem, PostAction } from './Feed/index';
import { UIPost as Post } from '@mention/shared-types';
import { usePostsStore } from '../stores/postsStore';

const HEADER_HEIGHT_EXPANDED = 80;
const HEADER_HEIGHT_NARROWED = 110;

const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView as any);



const TwitterProfile: React.FC = () => {
    const { user: currentUser, logout, oxyServices, showBottomSheet } = useOxy();
    const { posts, replies, reposts } = usePostsStore();
    let { username } = useLocalSearchParams<{ username: string }>();
    if (username && username.startsWith('@')) {
        username = username.slice(1);
    }

    const [activeTab, setActiveTab] = useState(0);
    const [profileData, setProfileData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const scrollY = useRef(new Animated.Value(0)).current;
    const insets = useSafeAreaInsets();

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







    const mediaImages = [
        'https://images.unsplash.com/photo-1551650975-87deedd944c3?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1517077304055-6e89abbf09b0?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1581291518857-4e27b48ff24e?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1487014679447-9f8336841d58?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1605379399642-870262d3d051?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1573164713714-d95e436ab8d6?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1576091160399-112ba8d25d1f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400&h=400&fit=crop',
    ];

    const tabs = ['Posts', 'Replies', 'Media', 'Likes', 'Reposts'];

    // Filter posts for different tabs
    const userPosts = posts.filter(post => post.user.handle === username);
    const userReplies = replies.filter(reply => reply.user.handle === username);
    const userReposts = reposts.filter(repost => repost.user.handle === username);
    const userLikes = posts.filter(post => post.engagement.likes > 0);

    const tabData = [userPosts, userReplies, mediaImages, userLikes, userReposts];

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

    const handlePostAction = (action: PostAction, postId: string) => {
        console.log(`${action} action for post ${postId}`);
        // Post actions are handled by the Feed component and store
    };

    const handleMediaPress = (imageUrl: string, index: number) => {
        console.log(`Media pressed: ${imageUrl} at index ${index}`);
        // TODO: Implement media viewer
    };

    const renderTabContent = () => {
        const data = tabData[activeTab];
        const feedType = activeTab === 0 ? 'posts' : activeTab === 1 ? 'replies' : activeTab === 2 ? 'media' : activeTab === 3 ? 'likes' : 'reposts';

        return (
            <Feed
                data={data}
                type={feedType}
                onPostAction={handlePostAction}
                onMediaPress={handleMediaPress}
            />
        );
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {loading ? (
                <View style={styles.loadingContainer}>
                    <Text style={styles.loadingText}>Loading profile...</Text>
                </View>
            ) : (
                <>
                    {/* Back button */}
                    <View style={[styles.backButton, { top: insets.top + 5 }]}>
                        <TouchableOpacity onPress={() => router.back()}>
                            <Ionicons name="arrow-back" size={20} color="white" />
                        </TouchableOpacity>
                    </View>

                    {/* Header actions */}
                    <View style={[styles.headerActions, { top: insets.top + 5 }]}>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="notifications-outline" size={20} color="white" />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="search-outline" size={20} color="white" />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton} onPress={handleShare}>
                            <Ionicons name="share-outline" size={20} color="white" />
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
                        <Text style={styles.headerTitle}>
                            {profileData?.name?.full || profileData?.username}
                        </Text>
                        <Text style={styles.headerSubtitle}>
                            {profileData?.postCount || 0} posts
                        </Text>
                    </Animated.View>

                    {/* Banner */}
                    <AnimatedImageBackground
                        source={{ uri: 'https://pbs.twimg.com/profile_banners/1113181835314507777/1746124248/1500x500' }}
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
                        <AnimatedBlurView
                            tint="dark"
                            intensity={50}
                            style={[
                                StyleSheet.absoluteFillObject,
                                {
                                    zIndex: 2,
                                    opacity: scrollY.interpolate({
                                        inputRange: [-50, 0, 30, 100],
                                        outputRange: [1, 0, 0, 0.7],
                                    }),
                                },
                            ]}
                        />
                    </AnimatedImageBackground>

                    {/* Profile content + posts */}
                    {/* ScrollView with stickyHeaderIndices */}
                    <Animated.ScrollView
                        showsVerticalScrollIndicator={false}
                        onScroll={Animated.event(
                            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                            { useNativeDriver: true }
                        )}
                        scrollEventThrottle={16}
                        style={[styles.scrollView, { marginTop: HEADER_HEIGHT_NARROWED }]}
                        contentContainerStyle={{ paddingTop: HEADER_HEIGHT_EXPANDED }}
                        stickyHeaderIndices={[1]}
                    >
                        {/* Profile info */}
                        <View style={styles.profileContent}>
                            <View style={styles.avatarRow}>
                                <Animated.Image
                                    source={{ uri: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg' }}
                                    style={[
                                        styles.avatar,
                                        {
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
                                        },
                                    ]}
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
                                                <Ionicons name="settings-outline" size={20} color="#FFF" />
                                            </TouchableOpacity>
                                        </View>
                                    ) : (
                                        <FollowButton userId={profileData?.id} />
                                    )}
                                </View>
                            </View>

                            <View>
                                <Text style={styles.profileName}>
                                    {profileData?.name?.full || profileData?.username}
                                </Text>
                                <View style={styles.handleRow}>
                                    <Text style={styles.profileHandle}>
                                        @{profileData?.username || 'username'}
                                    </Text>
                                    {profileData?.privacySettings?.isPrivateAccount && (
                                        <View style={styles.privateIndicator}>
                                            <Ionicons name="lock-closed" size={12} color="#666" />
                                            <Text style={styles.privateText}>Private</Text>
                                        </View>
                                    )}
                                </View>
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
                                    <Text style={styles.metaText}>Joined {new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</Text>
                                </View>
                            </View>

                            {(!profileData?.privacySettings?.isPrivateAccount || currentUser?.username === username) && (
                                <View style={styles.followStats}>
                                    <TouchableOpacity style={styles.statItem}>
                                        <Text style={styles.statNumber}>
                                            {profileData?._count?.followers || 0}
                                        </Text>
                                        <Text style={styles.statLabel}>Following</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.statItem}>
                                        <Text style={styles.statNumber}>
                                            {profileData?._count?.following || 0}
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
                                                                style={styles.communityIconImage}
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
                                                activeTab === i && styles.activeTabText,
                                            ]}
                                        >
                                            {tab}
                                        </Text>
                                        {activeTab === i && <View style={styles.tabIndicator} />}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>

                        {/* Tab Content */}
                        {renderTabContent()}
                    </Animated.ScrollView>


                    {/* FAB */}
                    <TouchableOpacity
                        style={styles.fab}
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
        backgroundColor: '#000',
    },
    backButton: {
        zIndex: 2,
        position: 'absolute',
        left: 16,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        height: 32,
        width: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerActions: {
        zIndex: 2,
        position: 'absolute',
        right: 16,
        flexDirection: 'row',
        gap: 12,
    },
    headerIconButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 2,
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
        color: 'white',
        marginBottom: -3,
    },
    headerSubtitle: {
        fontSize: 13,
        color: 'rgba(255, 255, 255, 0.8)',
    },
    banner: {
        position: 'absolute',
        left: 0,
        right: 0,
    },
    scrollView: {
        zIndex: 3,
    },
    profileContainer: {
        backgroundColor: '#000',
    },
    profileContent: {
        paddingHorizontal: 16,
        paddingBottom: 16,
        backgroundColor: '#000',
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
        borderColor: '#000',
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
        borderColor: '#2F3336',
    },
    followButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: '#FFF',
    },
    profileName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#FFF',
        marginTop: 10,
        marginBottom: 4,
    },
    profileHandle: {
        fontSize: 15,
        color: '#71767B',
        marginBottom: 12,
    },
    profileBio: {
        fontSize: 15,
        color: '#FFF',
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
        color: '#71767B',
        marginLeft: 4,
    },
    linkText: {
        color: '#1D9BF0',
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
        color: '#FFF',
        marginRight: 4,
    },
    statLabel: {
        fontSize: 15,
        color: '#71767B',
    },
    followedBy: {
        fontSize: 15,
        color: '#536471',
    },
    tabBarContainer: {
        backgroundColor: '#000',
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    tabBar: {
        flexDirection: 'row',
        backgroundColor: '#000',
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
        color: '#71767B',
    },
    activeTabText: {
        color: '#FFF',
        fontWeight: '700',
    },
    tabIndicator: {
        position: 'absolute',
        bottom: 0,
        width: 30,
        height: 2,
        backgroundColor: '#1D9BF0',
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
        color: '#1D9BF0',
        fontSize: 15,
        fontWeight: '600',
        textAlign: "center"
    },
    fab: {
        position: 'absolute',
        bottom: 40,
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        zIndex: 1000,
        backgroundColor: '#1D9BF0',
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
        backgroundColor: '#000',
    },
    loadingText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
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
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
    },

});

export default TwitterProfile;