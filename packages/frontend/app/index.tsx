import React, { useState, useEffect } from 'react';
import { SafeAreaView, StyleSheet, View, TouchableOpacity, Text, Platform } from 'react-native';
import Feed from '../components/Feed';
import CustomFeed from '../components/Feed/CustomFeed';
import { PostProvider } from '../context/PostContext';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { FeedType } from '@/hooks/useFeed';
import { useOxy } from '@oxyhq/services/full';
import { router } from 'expo-router';

type TabType = 'for-you' | 'following' | 'custom';

const HomeScreen: React.FC = () => {
    const [activeTab, setActiveTab] = useState<TabType>('for-you');
    const { t } = useTranslation();
    const { isAuthenticated } = useOxy();

    useEffect(() => {
        // Set default tab based on authentication
        if (isAuthenticated) {
            setActiveTab('for-you');
        } else {
            setActiveTab('for-you'); // Show explore feed for unauthenticated users
        }
    }, [isAuthenticated]);

    const handleCreatePostPress = () => {
        router.push('/compose');
    };

    const getFeedType = (): FeedType => {
        if (activeTab === 'following') return 'following';
        if (activeTab === 'for-you') return isAuthenticated ? 'home' : 'all';
        return 'all'; // fallback
    };

    const renderFeedContent = () => {
        if (activeTab === 'custom') {
            return (
                <CustomFeed
                    title={t('My Custom Feed')}
                    initialFilters={{
                        hashtags: [],
                        users: [],
                        keywords: [],
                        mediaOnly: false
                    }}
                />
            );
        }

        return (
            <Feed
                showCreatePost
                type={getFeedType()}
                onCreatePostPress={handleCreatePostPress}
            />
        );
    };

    return (
        <PostProvider>
            <SafeAreaView style={styles.container}>
                {/* Enhanced Tab Navigation */}
                <View style={styles.tabsContainer}>
                    <TouchableOpacity
                        style={[styles.tab, activeTab === 'for-you' && styles.activeTab]}
                        onPress={() => setActiveTab('for-you')}
                    >
                        <Text style={[styles.tabText, activeTab === 'for-you' && styles.activeTabText]}>
                            {t('For You')}
                        </Text>
                    </TouchableOpacity>

                    {isAuthenticated && (
                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'following' && styles.activeTab]}
                            onPress={() => setActiveTab('following')}
                        >
                            <Text style={[styles.tabText, activeTab === 'following' && styles.activeTabText]}>
                                {t('Following')}
                            </Text>
                        </TouchableOpacity>
                    )}

                    <TouchableOpacity
                        style={[styles.tab, activeTab === 'custom' && styles.activeTab]}
                        onPress={() => setActiveTab('custom')}
                    >
                        <Text style={[styles.tabText, activeTab === 'custom' && styles.activeTabText]}>
                            🔧 {t('Custom')}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Feed Content */}
                {renderFeedContent()}
            </SafeAreaView>
        </PostProvider>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    tabsContainer: {
        flexDirection: 'row',
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: Platform.OS === 'android' ? 2 : 0,
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
    },
    activeTab: {
        borderBottomWidth: 3,
        borderBottomColor: colors.primaryColor,
    },
    tabText: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center',
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: 'bold',
    },
});

export default HomeScreen;