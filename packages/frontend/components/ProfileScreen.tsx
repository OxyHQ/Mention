import { Ionicons } from '@expo/vector-icons';
import { Avatar, FollowButton, Models, useOxy } from '@oxyhq/services/full';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feed from './Feed';
import { FeedType } from '@/hooks/useFeed';

export default function ProfileScreen() {
    const { user: currentUser, logout, oxyServices, showBottomSheet } = useOxy();
    let { username } = useLocalSearchParams<{ username: string }>();
    if (username && username.startsWith('@')) {
      username = username.slice(1);
    }

    const [profileData, setProfileData] = useState<Models.User | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isCurrentUser, setIsCurrentUser] = useState(true);
    const [activeTab, setActiveTab] = useState('posts'); // For Twitter-like content tabs

    const fetchProfileData = useCallback(async (username: string) => {
        try {
            setIsLoading(true);
            setError(null);

            const data = await oxyServices.getProfileByUsername(username);
            console.log('Fetched profile data:', data);

            // Transform API data to our ProfileData format
            const userData = data as any;

            // Format name if available
            let fullName = '';
            if (userData.name) {
                const firstName = userData.name.first || '';
                const lastName = userData.name.last || '';
                fullName = [firstName, lastName].filter(Boolean).join(' ');
            }

            setProfileData({
                id: userData._id || userData.id,
                username: userData.username,
                profilePicture: userData.profilePicture || userData.avatar,
                coverPhoto: userData.coverPhoto || 'https://pbs.twimg.com/profile_banners/44196397/1576183471/1500x500', // Default cover
                email: userData.email,
                createdAt: userData.createdAt,
                fullName: fullName,
                description: userData.description || userData.bio,
                followersCount: userData._count?.followers,
                followingCount: userData._count?.following,
                location: userData.location
            });
        } catch (err: any) {
            console.error('Error fetching profile:', err);
            setError(err.message || 'Failed to load profile');
        } finally {
            setIsLoading(false);
        }
    }, [oxyServices]);

    // Fetch profile data if viewing another user
    useEffect(() => {
        if (username && username !== currentUser?.username) {
            setIsCurrentUser(false);
            fetchProfileData(username);
        } else {
            // Use current user data
            setIsCurrentUser(true);
            if (currentUser) {
                setProfileData(currentUser);
            }
        }
    }, [username, currentUser, fetchProfileData]);

    // Handle tab selection
    const handleTabPress = (tab: string) => {
        setActiveTab(tab);
    };

    // Loading state
    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#1DA1F2" />
                <Text style={styles.loadingText}>Loading profile...</Text>
            </View>
        );
    }

    // Error state
    if (error) {
        return (
            <View style={styles.errorContainer}>
                <Ionicons name="warning-outline" size={60} color="#ff6b6b" />
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                >
                    <Text style={styles.backButtonText}>Go Back</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <StatusBar style="dark" />
            <View style={styles.navigationHeader}>
                <TouchableOpacity
                    style={styles.backButtonSmall}
                    onPress={() => router.back()}
                >
                    <Ionicons name="arrow-back" size={22} color="#000" />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>
                    {profileData?.fullName || profileData?.username || 'Profile'}
                </Text>
            </View>

            <ScrollView style={styles.scrollView}>
                {/* Cover photo banner */}
                <View style={styles.coverPhotoContainer}>
                    <Image 
                        source={{ uri: profileData?.coverPhoto || 'https://pbs.twimg.com/profile_banners/44196397/1576183471/1500x500' }}
                        style={styles.coverPhoto}
                    />
                </View>

                {/* Profile section with avatar overlapping the banner */}
                <View style={styles.profileSection}>
                    <Avatar
                        uri={profileData?.profilePicture}
                        size={100}
                        style={styles.profileAvatar}
                    />

                    {/* Follow/Edit Profile button */}
                    <View style={styles.profileActionContainer}>
                        {isCurrentUser ? (
                            <TouchableOpacity style={styles.editProfileButton} onPress={() => showBottomSheet?.('AccountCenter')}>
                                <Text style={styles.editProfileButtonText}>Edit Profile</Text>
                            </TouchableOpacity>
                        ) : profileData?.id ? (
                            <FollowButton userId={profileData.id} size="small" />
                        ) : null}
                    </View>

                    {/* Profile info */}
                    <View style={styles.profileInfo}>
                        <Text style={styles.fullName}>{profileData?.fullName || 'User'}</Text>
                        <Text style={styles.username}>@{profileData?.username}</Text>
                        
                        {profileData?.description && (
                            <Text style={styles.bio}>{profileData.description}</Text>
                        )}

                        {/* Location and join date */}
                        <View style={styles.profileMetaInfo}>
                            {profileData?.location && (
                                <View style={styles.metaItem}>
                                    <Ionicons name="location-outline" size={16} color="#657786" />
                                    <Text style={styles.metaText}>{profileData.location}</Text>
                                </View>
                            )}
                            
                            {profileData?.createdAt && (
                                <View style={styles.metaItem}>
                                    <Ionicons name="calendar-outline" size={16} color="#657786" />
                                    <Text style={styles.metaText}>
                                        Joined {new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Followers/Following counts */}
                        <View style={styles.followStats}>
                            <TouchableOpacity 
                                style={styles.statItem}
                                onPress={() => router.push(`/${profileData?.username}/following`)}
                            >
                                <Text style={styles.statValue}>{profileData?.followingCount || 0}</Text>
                                <Text style={styles.statLabel}>Following</Text>
                            </TouchableOpacity>
                            
                            <TouchableOpacity 
                                style={styles.statItem}
                                onPress={() => router.push(`/${profileData?.username}/followers`)}
                            >
                                <Text style={styles.statValue}>{profileData?.followersCount || 0}</Text>
                                <Text style={styles.statLabel}>Followers</Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {/* Twitter-like content tabs */}
                    <View style={styles.tabsContainer}>
                        <TouchableOpacity 
                            style={[styles.tab, activeTab === 'posts' ? styles.activeTab : {}]}
                            onPress={() => handleTabPress('posts')}
                        >
                            <Text style={[styles.tabText, activeTab === 'posts' ? styles.activeTabText : {}]}>Posts</Text>
                        </TouchableOpacity>
                        
                        <TouchableOpacity 
                            style={[styles.tab, activeTab === 'replies' ? styles.activeTab : {}]}
                            onPress={() => handleTabPress('replies')}
                        >
                            <Text style={[styles.tabText, activeTab === 'replies' ? styles.activeTabText : {}]}>Replies</Text>
                        </TouchableOpacity>
                        
                        <TouchableOpacity 
                            style={[styles.tab, activeTab === 'media' ? styles.activeTab : {}]}
                            onPress={() => handleTabPress('media')}
                        >
                            <Text style={[styles.tabText, activeTab === 'media' ? styles.activeTabText : {}]}>Media</Text>
                        </TouchableOpacity>
                        
                        <TouchableOpacity 
                            style={[styles.tab, activeTab === 'likes' ? styles.activeTab : {}]}
                            onPress={() => handleTabPress('likes')}
                        >
                            <Text style={[styles.tabText, activeTab === 'likes' ? styles.activeTabText : {}]}>Likes</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Content area based on selected tab */}
                <View style={styles.contentArea}>
                    {activeTab === 'posts' && (
                        <Feed type="posts" parentId={profileData?.id} />
                    )}

                    {activeTab === 'replies' && (
                        <Feed type="replies" parentId={profileData?.id} />
                    )}

                    {activeTab === 'media' && (
                        <Feed type="media" parentId={profileData?.id} />
                    )}

                    {activeTab === 'likes' && (
                        <View style={styles.emptyStateContainer}>
                            <Ionicons name="heart-outline" size={40} color="#657786" />
                            <Text style={styles.emptyStateTitle}>No Likes Yet</Text>
                            <Text style={styles.emptyStateText}>Posts {isCurrentUser ? 'you have' : 'they have'} liked will show up here.</Text>
                        </View>
                    )}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    scrollView: {
        flex: 1,
        backgroundColor: '#fff',
    },
    // Twitter-style navigation header
    navigationHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: '#E1E8ED',
        backgroundColor: '#fff',
    },
    backButtonSmall: {
        padding: 8,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginLeft: 16,
        color: '#14171A',
    },
    // Cover photo
    coverPhotoContainer: {
        height: 150,
        width: '100%',
        backgroundColor: '#AAB8C2',
    },
    coverPhoto: {
        height: '100%',
        width: '100%',
        resizeMode: 'cover',
    },
    // Profile section
    profileSection: {
        paddingBottom: 10,
    },
    profileAvatar: {
        marginTop: -40,
        marginLeft: 16,
        borderWidth: 5,
        borderColor: '#fff',
    },
    profileActionContainer: {
        position: 'absolute',
        right: 16,
        top: 10,
    },
    editProfileButton: {
        borderWidth: 1,
        borderColor: '#1DA1F2',
        borderRadius: 50,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    editProfileButtonText: {
        color: '#1DA1F2',
        fontWeight: '600',
        fontSize: 14,
    },
    followButton: {
        backgroundColor: '#1DA1F2',
        borderRadius: 50,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    followingButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: '#1DA1F2',
    },
    followButtonText: {
        color: '#fff',
        fontWeight: '600',
        fontSize: 14,
    },
    followingButtonText: {
        color: '#1DA1F2',
    },
    // Profile info
    profileInfo: {
        padding: 16,
    },
    fullName: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#14171A',
    },
    username: {
        fontSize: 15,
        color: '#657786',
        marginBottom: 10,
    },
    bio: {
        fontSize: 15,
        color: '#14171A',
        marginBottom: 12,
        lineHeight: 20,
    },
    profileMetaInfo: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 12,
    },
    metaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 16,
        marginBottom: 6,
    },
    metaText: {
        fontSize: 14,
        color: '#657786',
        marginLeft: 4,
    },
    // Follow stats
    followStats: {
        flexDirection: 'row',
        marginTop: 4,
    },
    statItem: {
        flexDirection: 'row',
        marginRight: 16,
    },
    statValue: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#14171A',
        marginRight: 4,
    },
    statLabel: {
        fontSize: 14,
        color: '#657786',
    },
    // Tabs
    tabsContainer: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: '#E1E8ED',
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 16,
    },
    activeTab: {
        borderBottomWidth: 2,
        borderBottomColor: '#1DA1F2',
    },
    tabText: {
        color: '#657786',
        fontWeight: '500',
    },
    activeTabText: {
        color: '#1DA1F2',
        fontWeight: 'bold',
    },
    // Content area
    contentArea: {
        minHeight: 300,
    },
    emptyStateContainer: {
        padding: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyStateTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#14171A',
        marginTop: 10,
        marginBottom: 8,
    },
    emptyStateText: {
        fontSize: 15,
        color: '#657786',
        textAlign: 'center',
    },
    // Loading state
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    loadingText: {
        fontSize: 16,
        marginTop: 12,
        color: '#657786',
    },
    // Error state
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    errorText: {
        fontSize: 16,
        marginTop: 12,
        color: '#ff6b6b',
        textAlign: 'center',
        marginBottom: 20,
    },
    backButton: {
        backgroundColor: '#1DA1F2',
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 50,
        marginTop: 16,
    },
    backButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
});
