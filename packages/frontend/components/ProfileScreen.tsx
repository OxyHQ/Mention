import React, { useState, useEffect, useCallback } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Image,
    Alert
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { Feed } from './Feed/index';
import { usePostsStore } from '../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import { Ionicons } from '@expo/vector-icons';

const ProfileScreen: React.FC = () => {
    const { user: currentUser, oxyServices } = useOxy();
    const { fetchUserFeed } = usePostsStore();
    let { username } = useLocalSearchParams<{ username: string }>();

    if (username && username.startsWith('@')) {
        username = username.substring(1);
    }

    const [profileData, setProfileData] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'posts' | 'replies' | 'media' | 'likes'>('posts');

    // Fetch profile data
    useEffect(() => {
        const fetchProfile = async () => {
            if (!username) return;

            try {
                setIsLoading(true);
                setError(null);

                // Fetch user profile from Oxy
                const userData = await oxyServices.getProfileByUsername(username);
                setProfileData(userData);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to fetch profile');
                console.error('Error fetching profile:', err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchProfile();
    }, [username, oxyServices]);

    // Handle post press
    const handlePostPress = useCallback((postId: string) => {
        router.push(`/p/${postId}`);
    }, []);

    // Handle user press
    const handleUserPress = useCallback((username: string) => {
        router.push(`/@${username}`);
    }, []);

    // Handle reply press
    const handleReplyPress = useCallback((postId: string) => {
        router.push(`/reply?postId=${postId}`);
    }, []);

    // Handle repost press
    const handleRepostPress = useCallback((postId: string) => {
        router.push(`/repost?postId=${postId}`);
    }, []);

    // Handle like press
    const handleLikePress = useCallback(async (postId: string) => {
        try {
            const { likePost, unlikePost } = usePostsStore.getState();
            // TODO: Check if post is already liked and toggle accordingly
            await likePost({ postId });
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    }, []);

    // Handle share press
    const handleSharePress = useCallback((postId: string) => {
        // TODO: Implement share functionality
        Alert.alert('Share', `Share post ${postId}`);
    }, []);

    // Handle save press
    const handleSavePress = useCallback(async (postId: string) => {
        try {
            const { savePost, unsavePost } = usePostsStore.getState();
            // TODO: Check if post is already saved and toggle accordingly
            await savePost({ postId });
        } catch (error) {
            console.error('Error toggling save:', error);
        }
    }, []);

    // Render profile feed content
    const renderProfileFeedContent = () => {
        if (!profileData?.id) return null;

        return (
            <Feed
                type={activeTab as FeedType}
                userId={profileData.id}
                onPostPress={handlePostPress}
                onUserPress={handleUserPress}
                onReplyPress={handleReplyPress}
                onRepostPress={handleRepostPress}
                onLikePress={handleLikePress}
                onSharePress={handleSharePress}
                onSavePress={handleSavePress}
            />
        );
    };

    // Render profile tabs
    const renderProfileTabs = () => {
        const tabs = [
            { key: 'posts', label: 'Posts', icon: 'document-text' },
            { key: 'replies', label: 'Replies', icon: 'chatbubble' },
            { key: 'media', label: 'Media', icon: 'image' },
            { key: 'likes', label: 'Likes', icon: 'heart' }
        ];

        return (
            <View style={styles.profileTabsContainer}>
                {tabs.map((tab) => (
                    <TouchableOpacity
                        key={tab.key}
                        style={[
                            styles.profileTabButton,
                            activeTab === tab.key && styles.activeProfileTabButton
                        ]}
                        onPress={() => setActiveTab(tab.key as any)}
                    >
                        <Ionicons
                            name={tab.icon as any}
                            size={20}
                            color={activeTab === tab.key ? '#1D9BF0' : '#71767B'}
                        />
                        <Text style={[
                            styles.profileTabButtonText,
                            activeTab === tab.key && styles.activeProfileTabButtonText
                        ]}>
                            {tab.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>
        );
    };

    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <Text style={styles.loadingText}>Loading profile...</Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>Error: {error}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={() => window.location.reload()}>
                    <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
            </View>
        );
    }

    if (!profileData) {
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>Profile not found</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* Profile Header */}
            <View style={styles.profileHeader}>
                <Image
                    source={{ uri: profileData.avatar?.url || profileData.avatar }}
                    style={styles.avatar}
                />
                <Text style={styles.username}>@{profileData.username}</Text>
                <Text style={styles.displayName}>
                    {profileData.name?.full || profileData.username}
                </Text>

                {profileData.bio && (
                    <Text style={styles.bio} numberOfLines={3}>
                        {profileData.bio}
                    </Text>
                )}

                <View style={styles.statsContainer}>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>{profileData.postsCount || 0}</Text>
                        <Text style={styles.statLabel}>Posts</Text>
                    </View>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>{profileData.followersCount || 0}</Text>
                        <Text style={styles.statLabel}>Followers</Text>
                    </View>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>{profileData.followingCount || 0}</Text>
                        <Text style={styles.statLabel}>Following</Text>
                    </View>
                </View>
            </View>

            {/* Profile Tabs */}
            {renderProfileTabs()}

            {/* Profile Feed Content */}
            <View style={styles.profileFeedContainer}>
                {renderProfileFeedContent()}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#000',
    },
    loadingText: {
        color: '#fff',
        fontSize: 16,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#000',
        padding: 20,
    },
    errorText: {
        color: '#E0245E',
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
    },
    retryButton: {
        backgroundColor: '#1D9BF0',
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 20,
    },
    retryButtonText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
    },
    profileHeader: {
        alignItems: 'center',
        paddingVertical: 20,
        paddingHorizontal: 20,
        backgroundColor: '#000',
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        marginBottom: 12,
    },
    username: {
        fontSize: 16,
        color: '#71767B',
        marginBottom: 4,
    },
    displayName: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#fff',
        marginBottom: 8,
    },
    bio: {
        fontSize: 14,
        color: '#fff',
        textAlign: 'center',
        marginBottom: 16,
        lineHeight: 20,
    },
    statsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
    },
    statItem: {
        alignItems: 'center',
    },
    statNumber: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#fff',
    },
    statLabel: {
        fontSize: 12,
        color: '#71767B',
        marginTop: 2,
    },
    profileTabsContainer: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
        backgroundColor: '#000',
    },
    profileTabButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
        gap: 8,
    },
    activeProfileTabButton: {
        borderBottomWidth: 2,
        borderBottomColor: '#1D9BF0',
    },
    profileTabButtonText: {
        fontSize: 16,
        fontWeight: '500',
        color: '#71767B',
    },
    activeProfileTabButtonText: {
        color: '#1D9BF0',
        fontWeight: '600',
    },
    profileFeedContainer: {
        flex: 1,
    },
});

export default ProfileScreen;