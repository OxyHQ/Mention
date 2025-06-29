import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useAppSelector, useAppDispatch } from '@/hooks/useRedux';
import { useOxy } from '@oxyhq/services/full';

// Import actions from different reducers
import { fetchTrends } from '@/store/reducers/trendsReducer';
import { fetchAnalytics } from '@/store/reducers/analyticsReducer';
import { setCurrentProfile, clearCurrentProfile, fetchProfile, updateProfile, followUser } from '@/store/reducers/profileReducer';
import {
    fetchFeed,
    likePost,
    createPost,
    toggleLikeLocally
} from '@/store/reducers/postsReducer';
import {
    addNotification,
    openComposeModal,
    closeComposeModal,
    setAppLoading,
    toggleSidebar
} from '@/store/reducers/uiReducer';

/**
 * This component demonstrates how to use Redux across the app
 * with all the different reducers and patterns we've set up,
 * integrating with OxyHQ Services for authentication.
 */
export const ReduxExample: React.FC = () => {
    const dispatch = useAppDispatch();

    // OxyHQ Services authentication state
    const { user: oxyUser, isAuthenticated, login, logout, isLoading: oxyLoading } = useOxy();

    // Using selectors to get state from different reducers
    const trends = useAppSelector((state) => state.trends.trends);
    const trendsLoading = useAppSelector((state) => state.trends.isLoading);

    const analytics = useAppSelector((state) => state.analytics.data);
    const analyticsLoading = useAppSelector((state) => state.analytics.loading);

    // Profile state (linked to Oxy user)
    const currentProfile = useAppSelector((state) => state.profile.currentProfile);
    const profileLoading = useAppSelector((state) => state.profile.profileLoading);

    const posts = useAppSelector((state) => {
        const allPosts = state.posts.feedPosts.all || [];
        return allPosts.map(postId => state.posts.posts[postId]).filter(Boolean);
    });
    const postsLoading = useAppSelector((state) => state.posts.isLoading);

    const notifications = useAppSelector((state) => state.ui.notifications);
    const isComposeModalOpen = useAppSelector((state) => state.ui.isComposeModalOpen);
    const sidebarCollapsed = useAppSelector((state) => state.ui.sidebarCollapsed);

    // Example of using async thunks
    const handleFetchTrends = () => {
        dispatch(fetchTrends());
    };

    const handleFetchAnalytics = () => {
        if (oxyUser) {
            dispatch(fetchAnalytics({
                userID: oxyUser.id,
                period: '7d'
            }));
        }
    };

    const handleFetchFeed = () => {
        dispatch(fetchFeed({ type: 'all', limit: 10 }));
    };

    const handleCreatePost = () => {
        dispatch(createPost({
            text: 'Hello from Redux! This is a test post created at ' + new Date().toLocaleTimeString(),
        }));
    };

    const handleLikePost = (postId: string) => {
        // Optimistic update for better UX
        dispatch(toggleLikeLocally(postId));
        // Then make the API call
        dispatch(likePost(postId));
    };

    // Example of authentication actions using OxyHQ Services
    const handleLogin = async () => {
        try {
            await login('testuser', 'password123');
            dispatch(addNotification({
                type: 'success',
                title: 'Welcome back!',
                message: 'You have successfully logged in via Oxy.',
            }));
        } catch (error) {
            dispatch(addNotification({
                type: 'error',
                title: 'Login failed',
                message: 'Could not authenticate with Oxy services.',
            }));
        }
    };

    const handleLogout = async () => {
        try {
            await logout();
            dispatch(clearCurrentProfile());
            dispatch(addNotification({
                type: 'info',
                title: 'Logged out',
                message: 'You have been logged out successfully.',
            }));
        } catch (error) {
            dispatch(addNotification({
                type: 'error',
                title: 'Logout failed',
                message: 'Error logging out.',
            }));
        }
    };

    // Profile management actions
    const handleFetchProfile = () => {
        if (oxyUser) {
            dispatch(fetchProfile(oxyUser.id));
        }
    };

    const handleUpdateProfile = () => {
        if (oxyUser) {
            dispatch(updateProfile({
                oxyUserId: oxyUser.id,
                bio: 'Updated bio at ' + new Date().toLocaleTimeString(),
                displayName: 'Updated Name',
            }));
        }
    };

    const handleFollowUser = () => {
        // Example follow action
        dispatch(followUser('example-oxy-user-id'));
    };

    // Example of UI actions
    const handleShowNotification = (type: 'success' | 'error' | 'warning' | 'info') => {
        dispatch(addNotification({
            type,
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} notification`,
            message: `This is a ${type} notification example.`,
        }));
    };

    const handleToggleCompose = () => {
        if (isComposeModalOpen) {
            dispatch(closeComposeModal());
        } else {
            dispatch(openComposeModal({}));
        }
    };

    const handleToggleSidebar = () => {
        dispatch(toggleSidebar());
    };

    const handleAppLoading = () => {
        dispatch(setAppLoading(true));
        setTimeout(() => {
            dispatch(setAppLoading(false));
            dispatch(addNotification({
                type: 'success',
                title: 'Loading complete',
                message: 'App loading simulation finished.',
            }));
        }, 2000);
    };

    // Fetch initial data when component mounts
    useEffect(() => {
        dispatch(fetchTrends());
        dispatch(fetchFeed({ type: 'all', limit: 5 }));
    }, [dispatch]);

    // Sync Oxy authentication with profile state
    useEffect(() => {
        if (isAuthenticated && oxyUser && !currentProfile) {
            // Fetch or create profile when Oxy user is authenticated
            dispatch(fetchProfile(oxyUser.id));
        } else if (!isAuthenticated && currentProfile) {
            // Clear profile when logged out
            dispatch(clearCurrentProfile());
        }
    }, [isAuthenticated, oxyUser, currentProfile, dispatch]);

    return (
        <ScrollView style={styles.container}>
            <Text style={styles.title}>Redux Integration Example</Text>

            {/* Authentication State Section (Oxy + Profile) */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Authentication & Profile</Text>
                <Text>Oxy Authenticated: {isAuthenticated ? 'Yes' : 'No'}</Text>
                <Text>Oxy Loading: {oxyLoading ? 'Yes' : 'No'}</Text>
                {oxyUser && (
                    <Text>Oxy User: {oxyUser.username} (ID: {oxyUser.id})</Text>
                )}
                <Text>Profile Loaded: {currentProfile ? 'Yes' : 'No'}</Text>
                <Text>Profile Loading: {profileLoading ? 'Yes' : 'No'}</Text>
                {currentProfile && (
                    <View>
                        <Text>Profile: {currentProfile.displayName || currentProfile.username}</Text>
                        <Text>Bio: {currentProfile.bio || 'No bio'}</Text>
                    </View>
                )}
                <View style={styles.buttonRow}>
                    <TouchableOpacity style={styles.button} onPress={handleLogin}>
                        <Text style={styles.buttonText}>Login (Oxy)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleLogout}>
                        <Text style={styles.buttonText}>Logout</Text>
                    </TouchableOpacity>
                </View>
                <View style={styles.buttonRow}>
                    <TouchableOpacity style={styles.button} onPress={handleFetchProfile}>
                        <Text style={styles.buttonText}>Fetch Profile</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleUpdateProfile}>
                        <Text style={styles.buttonText}>Update Profile</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleFollowUser}>
                        <Text style={styles.buttonText}>Follow User</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Trends Section */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Trends</Text>
                <Text>Loading: {trendsLoading ? 'Yes' : 'No'}</Text>
                <Text>Count: {trends.length}</Text>
                <TouchableOpacity style={styles.button} onPress={handleFetchTrends}>
                    <Text style={styles.buttonText}>Fetch Trends</Text>
                </TouchableOpacity>
            </View>

            {/* Analytics Section */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Analytics</Text>
                <Text>Loading: {analyticsLoading ? 'Yes' : 'No'}</Text>
                <Text>Data: {analytics ? 'Available' : 'None'}</Text>
                <TouchableOpacity style={styles.button} onPress={handleFetchAnalytics}>
                    <Text style={styles.buttonText}>Fetch Analytics</Text>
                </TouchableOpacity>
            </View>

            {/* Posts Section */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Posts</Text>
                <Text>Loading: {postsLoading ? 'Yes' : 'No'}</Text>
                <Text>Posts Count: {posts.length}</Text>
                <View style={styles.buttonRow}>
                    <TouchableOpacity style={styles.button} onPress={handleFetchFeed}>
                        <Text style={styles.buttonText}>Fetch Feed</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleCreatePost}>
                        <Text style={styles.buttonText}>Create Post</Text>
                    </TouchableOpacity>
                </View>
                {posts.slice(0, 3).map((post) => (
                    <View key={post.id} style={styles.postItem}>
                        <Text numberOfLines={2}>{post.text}</Text>
                        <TouchableOpacity
                            style={styles.likeButton}
                            onPress={() => handleLikePost(post.id)}
                        >
                            <Text>{post.isLiked ? '❤️' : '🤍'} {post.likes.length}</Text>
                        </TouchableOpacity>
                    </View>
                ))}
            </View>

            {/* UI State Section */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>UI State</Text>
                <Text>Compose Modal: {isComposeModalOpen ? 'Open' : 'Closed'}</Text>
                <Text>Sidebar: {sidebarCollapsed ? 'Collapsed' : 'Expanded'}</Text>
                <Text>Notifications: {notifications.length}</Text>

                <View style={styles.buttonGrid}>
                    <TouchableOpacity style={styles.button} onPress={handleToggleCompose}>
                        <Text style={styles.buttonText}>Toggle Compose</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleToggleSidebar}>
                        <Text style={styles.buttonText}>Toggle Sidebar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.button} onPress={handleAppLoading}>
                        <Text style={styles.buttonText}>Simulate Loading</Text>
                    </TouchableOpacity>
                </View>

                <Text style={styles.sectionTitle}>Notifications</Text>
                <View style={styles.buttonRow}>
                    <TouchableOpacity style={[styles.button, { backgroundColor: '#4CAF50' }]} onPress={() => handleShowNotification('success')}>
                        <Text style={styles.buttonText}>Success</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { backgroundColor: '#f44336' }]} onPress={() => handleShowNotification('error')}>
                        <Text style={styles.buttonText}>Error</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { backgroundColor: '#ff9800' }]} onPress={() => handleShowNotification('warning')}>
                        <Text style={styles.buttonText}>Warning</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { backgroundColor: '#2196F3' }]} onPress={() => handleShowNotification('info')}>
                        <Text style={styles.buttonText}>Info</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Current Notifications */}
            {notifications.length > 0 && (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Active Notifications</Text>
                    {notifications.map((notification) => (
                        <View key={notification.id} style={styles.notification}>
                            <Text style={styles.notificationTitle}>{notification.title}</Text>
                            <Text>{notification.message}</Text>
                        </View>
                    ))}
                </View>
            )}
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
        backgroundColor: '#f5f5f5',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
    },
    section: {
        backgroundColor: 'white',
        padding: 15,
        marginBottom: 15,
        borderRadius: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 10,
        color: '#333',
    },
    button: {
        backgroundColor: '#007AFF',
        padding: 10,
        borderRadius: 5,
        marginVertical: 5,
        minWidth: 80,
    },
    buttonText: {
        color: 'white',
        textAlign: 'center',
        fontWeight: '500',
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 10,
    },
    buttonGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 10,
    },
    postItem: {
        backgroundColor: '#f8f8f8',
        padding: 10,
        marginVertical: 5,
        borderRadius: 5,
        borderLeftWidth: 3,
        borderLeftColor: '#007AFF',
    },
    likeButton: {
        marginTop: 5,
        alignSelf: 'flex-start',
    },
    notification: {
        backgroundColor: '#e3f2fd',
        padding: 10,
        marginVertical: 5,
        borderRadius: 5,
        borderLeftWidth: 3,
        borderLeftColor: '#2196F3',
    },
    notificationTitle: {
        fontWeight: 'bold',
        marginBottom: 5,
    },
}); 