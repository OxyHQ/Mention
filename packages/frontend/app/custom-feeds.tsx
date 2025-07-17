import React, { useState, useEffect } from 'react';
import { SafeAreaView, StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, ScrollView } from 'react-native';
import CustomFeed from '@/components/Feed/CustomFeed';
import { PostProvider } from '@/context/PostContext';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';

interface SavedFeed {
    id: string;
    name: string;
    description?: string;
    filters: {
        users: string[];
        hashtags: string[];
        keywords: string[];
        mediaOnly: boolean;
    };
    created_at: string;
}

const CustomFeedsScreen: React.FC = () => {
    const { t } = useTranslation();
    const [savedFeeds, setSavedFeeds] = useState<SavedFeed[]>([]);
    const [activeFeed, setActiveFeed] = useState<SavedFeed | null>(null);
    const [showCreateNew, setShowCreateNew] = useState(false);

    // Sample saved feeds for demonstration
    useEffect(() => {
        const sampleFeeds: SavedFeed[] = [
            {
                id: '1',
                name: 'Tech News',
                description: 'Latest in technology and programming',
                filters: {
                    hashtags: ['tech', 'programming', 'ai', 'javascript', 'react'],
                    users: ['sarah_dev', 'john_cto', 'nina_ai'],
                    keywords: ['coding', 'development'],
                    mediaOnly: false
                },
                created_at: new Date().toISOString()
            },
            {
                id: '2',
                name: 'Visual Content',
                description: 'Photos, videos, and visual posts only',
                filters: {
                    hashtags: ['photography', 'design', 'art'],
                    users: ['mike_design', 'lisa_marketing'],
                    keywords: [],
                    mediaOnly: true
                },
                created_at: new Date().toISOString()
            },
            {
                id: '3',
                name: 'Startup Scene',
                description: 'Startup news and entrepreneur insights',
                filters: {
                    hashtags: ['startup', 'entrepreneur', 'funding', 'growth'],
                    users: ['alex_startup', 'david_product'],
                    keywords: ['venture', 'investment', 'scaling'],
                    mediaOnly: false
                },
                created_at: new Date().toISOString()
            }
        ];
        setSavedFeeds(sampleFeeds);
        setActiveFeed(sampleFeeds[0]); // Set first feed as default
    }, []);

    const handleCreateNewFeed = () => {
        setActiveFeed(null);
        setShowCreateNew(true);
    };

    const handleSelectFeed = (feed: SavedFeed) => {
        setActiveFeed(feed);
        setShowCreateNew(false);
    };

    const handleSaveFeed = (filters: any) => {
        // In a real app, this would save to user preferences/backend
        Alert.alert(
            t('Save Feed'),
            t('Feed configuration saved! This is a demo - in the real app, feeds would be saved to your account.'),
            [{ text: t('OK') }]
        );
    };

    const handleDeleteFeed = (feedId: string) => {
        Alert.alert(
            t('Delete Feed'),
            t('Are you sure you want to delete this custom feed?'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Delete'),
                    style: 'destructive',
                    onPress: () => {
                        setSavedFeeds(prev => prev.filter(feed => feed.id !== feedId));
                        if (activeFeed?.id === feedId) {
                            setActiveFeed(savedFeeds[0] || null);
                        }
                    }
                }
            ]
        );
    };

    const renderSavedFeedItem = ({ item }: { item: SavedFeed }) => {
        const isActive = activeFeed?.id === item.id;
        const filterCount = item.filters.hashtags.length + item.filters.users.length + item.filters.keywords.length;

        return (
            <TouchableOpacity
                style={[styles.feedItem, isActive && styles.activeFeedItem]}
                onPress={() => handleSelectFeed(item)}
            >
                <View style={styles.feedItemHeader}>
                    <Text style={[styles.feedItemName, isActive && styles.activeFeedItemText]}>
                        {item.name}
                    </Text>
                    <TouchableOpacity
                        style={styles.deleteButton}
                        onPress={() => handleDeleteFeed(item.id)}
                    >
                        <Text style={styles.deleteButtonText}>✕</Text>
                    </TouchableOpacity>
                </View>

                {item.description && (
                    <Text style={[styles.feedItemDescription, isActive && styles.activeFeedItemText]}>
                        {item.description}
                    </Text>
                )}

                <View style={styles.feedItemMeta}>
                    <Text style={[styles.feedItemMetaText, isActive && styles.activeFeedItemText]}>
                        {filterCount} filter{filterCount !== 1 ? 's' : ''}
                        {item.filters.mediaOnly && ' • Media only'}
                    </Text>
                </View>
            </TouchableOpacity>
        );
    };

    if (showCreateNew) {
        return (
            <PostProvider>
                <SafeAreaView style={styles.container}>
                    <StatusBar style="dark" />

                    {/* Header */}
                    <View style={styles.header}>
                        <TouchableOpacity
                            style={styles.backButton}
                            onPress={() => setShowCreateNew(false)}
                        >
                            <Text style={styles.backButtonText}>← {t('Back')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.headerTitle}>{t('Create Custom Feed')}</Text>
                    </View>

                    <CustomFeed
                        title={t('New Custom Feed')}
                        onFiltersChange={handleSaveFeed}
                    />
                </SafeAreaView>
            </PostProvider>
        );
    }

    return (
        <PostProvider>
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />

                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                    >
                        <Text style={styles.backButtonText}>← {t('Back')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{t('Custom Feeds')}</Text>
                    <TouchableOpacity
                        style={styles.createButton}
                        onPress={handleCreateNewFeed}
                    >
                        <Text style={styles.createButtonText}>+ {t('New')}</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.content}>
                    {/* Saved Feeds List */}
                    <View style={styles.sidePanel}>
                        <Text style={styles.sidePanelTitle}>{t('My Feeds')}</Text>
                        <FlatList
                            data={savedFeeds}
                            keyExtractor={(item) => item.id}
                            renderItem={renderSavedFeedItem}
                            style={styles.feedsList}
                            showsVerticalScrollIndicator={false}
                        />
                    </View>

                    {/* Active Feed Content */}
                    <View style={styles.feedContent}>
                        {activeFeed ? (
                            <CustomFeed
                                title={activeFeed.name}
                                initialFilters={activeFeed.filters}
                                onFiltersChange={(filters) => {
                                    // Update the active feed with new filters
                                    setActiveFeed(prev => prev ? { ...prev, filters } : null);
                                }}
                            />
                        ) : (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyStateIcon}>🎯</Text>
                                <Text style={styles.emptyStateTitle}>{t('No Feed Selected')}</Text>
                                <Text style={styles.emptyStateText}>
                                    {t('Select a saved feed or create a new one to get started')}
                                </Text>
                                <TouchableOpacity
                                    style={styles.emptyStateButton}
                                    onPress={handleCreateNewFeed}
                                >
                                    <Text style={styles.emptyStateButtonText}>{t('Create Your First Feed')}</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                </View>
            </SafeAreaView>
        </PostProvider>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    backButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    backButtonText: {
        fontSize: 16,
        color: colors.primaryColor,
        fontWeight: '600',
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
        flex: 1,
        textAlign: 'center',
    },
    createButton: {
        backgroundColor: colors.primaryColor,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
    },
    createButtonText: {
        color: 'white',
        fontSize: 14,
        fontWeight: '600',
    },
    content: {
        flex: 1,
        flexDirection: 'row',
    },
    sidePanel: {
        width: 280,
        backgroundColor: 'white',
        borderRightWidth: 0.5,
        borderRightColor: colors.COLOR_BLACK_LIGHT_6,
    },
    sidePanelTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
        padding: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    feedsList: {
        flex: 1,
    },
    feedItem: {
        padding: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_7,
    },
    activeFeedItem: {
        backgroundColor: colors.primaryColor + '10',
        borderLeftWidth: 4,
        borderLeftColor: colors.primaryColor,
    },
    feedItemHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    feedItemName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        flex: 1,
    },
    activeFeedItemText: {
        color: colors.primaryColor,
    },
    deleteButton: {
        padding: 4,
    },
    deleteButtonText: {
        color: colors.COLOR_BLACK_LIGHT_4,
        fontSize: 16,
    },
    feedItemDescription: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginBottom: 8,
    },
    feedItemMeta: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    feedItemMetaText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    feedContent: {
        flex: 1,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyStateIcon: {
        fontSize: 60,
        marginBottom: 16,
    },
    emptyStateTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyStateText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center',
        marginBottom: 24,
        lineHeight: 22,
    },
    emptyStateButton: {
        backgroundColor: colors.primaryColor,
        paddingVertical: 12,
        paddingHorizontal: 24,
        borderRadius: 24,
    },
    emptyStateButtonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
});

export default CustomFeedsScreen; 