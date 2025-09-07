import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    Text,
    Image,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useOxy } from '@oxyhq/services';
import Feed from '../components/Feed/Feed';
import { Header } from '../components/Header';
import SignInPrompt from '../components/SignInPrompt';
import { colors } from '../styles/colors';
import { shadowStyle } from '@/utils/platformStyles';
import { usePostsStore } from '../stores/postsStore';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';

const PINNED_KEY = 'mention.pinnedFeeds';

type MainTabKey = 'for_you' | 'following' | `custom:${string}` | `list:${string}`;

const MainFeedScreen = () => {
    const { user, isAuthenticated, showBottomSheet: _showBottomSheet } = useOxy();
    const { savePost, unsavePost } = usePostsStore();
    const [activeTab, setActiveTab] = useState<MainTabKey>('for_you');
    const [pinnedCustomFeeds, setPinnedCustomFeeds] = useState<{ id: string; title: string; memberOxyUserIds: string[]; keywords?: string[]; includeReplies?: boolean; includeReposts?: boolean; includeMedia?: boolean; language?: string }[]>([]);
    const [pinnedLists, setPinnedLists] = useState<{ id: string; title: string; memberOxyUserIds: string[] }[]>([]);

    // Debug authentication state
    console.log('🔐 MainFeedScreen - isAuthenticated:', isAuthenticated, 'user:', user?.id);


    const handleSavePress = useCallback(async (postId: string) => {
        try {
            console.log('💾 Save button pressed for postId:', postId);

            const { feeds } = usePostsStore.getState();
            const post = feeds.posts.items.find(p => p.id === postId) ||
                feeds.mixed.items.find(p => p.id === postId);

            console.log('📄 Found post:', post?.id, 'isSaved:', post?.isSaved);

            if (post?.isSaved) {
                console.log('🗑️ Unsaving post...');
                await unsavePost({ postId });
            } else {
                console.log('💾 Saving post...');
                await savePost({ postId });
            }
        } catch (error) {
            console.error('❌ Error toggling save:', error);
        }
    }, [savePost, unsavePost]);


    const handleComposePress = useCallback(() => {
        // Navigate to compose screen
        router.push('/compose');
    }, []);

    const loadPinned = useCallback(async () => {
        try {
            const ids = (await getData<string[]>(PINNED_KEY)) || [];
            const customIds = ids
                .filter((s) => String(s).startsWith('custom:'))
                .map((s) => String(s).split(':')[1])
                .filter(Boolean);
            const listIds = ids
                .filter((s) => String(s).startsWith('list:'))
                .map((s) => String(s).split(':')[1])
                .filter(Boolean);
            if (!customIds.length) {
                setPinnedCustomFeeds([]);
            }
            const loaded = await Promise.all(
                customIds.map(async (id) => {
                    try {
                        const f = await customFeedsService.get(id);
                        return { id: String(f._id || f.id), title: f.title, memberOxyUserIds: f.memberOxyUserIds || [], keywords: f.keywords || [], includeReplies: f.includeReplies, includeReposts: f.includeReposts, includeMedia: f.includeMedia, language: f.language };
                    } catch {
                        return null;
                    }
                })
            );
            setPinnedCustomFeeds(loaded.filter(Boolean) as any);
            if (listIds.length) {
                const lloaded = await Promise.all(listIds.map(async (id) => {
                    try {
                        const l = await listsService.get(id);
                        return { id: String(l._id || l.id), title: l.title, memberOxyUserIds: l.memberOxyUserIds || [] };
                    } catch { return null; }
                }));
                setPinnedLists(lloaded.filter(Boolean) as any);
            } else {
                setPinnedLists([]);
            }
        } catch (e) {
            console.warn('Failed to load pinned feeds', e);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            loadPinned();
        }, [loadPinned])
    );

    useEffect(() => {
        // initial
        loadPinned();
    }, [loadPinned]);

    const tabs = useMemo(() => {
        const base: { key: MainTabKey; label: string }[] = [
            { key: 'for_you', label: 'For You' },
            { key: 'following', label: 'Following' },
        ];
        const customs = pinnedCustomFeeds.map((f) => ({ key: `custom:${f.id}` as MainTabKey, label: f.title }));
        const lists = pinnedLists.map((l) => ({ key: `list:${l.id}` as MainTabKey, label: l.title }));
        return [...base, ...customs, ...lists];
    }, [pinnedCustomFeeds, pinnedLists]);

    const renderTabButton = (tab: MainTabKey, label: string) => (
        <TouchableOpacity
            style={[styles.tabButton, activeTab === tab && styles.activeTabButton]}
            onPress={() => setActiveTab(tab)}
        >
            <Text style={[styles.tabLabel, activeTab === tab && styles.activeTabLabel]}>{label}</Text>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView edges={['top']}>
            <View style={styles.container}>
                <StatusBar style="dark" />

                {/* Header */}
                <Header
                    options={{
                        title: 'Mention',
                        rightComponents: [
                            <TouchableOpacity key="search" style={styles.headerButton} onPress={() => router.push('/search')}>
                                <Ionicons name="search-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                            </TouchableOpacity>,
                            <TouchableOpacity key="notifications" style={styles.headerButton} onPress={() => router.push('/notifications')}>
                                <Ionicons name="notifications-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                            </TouchableOpacity>,
                            <TouchableOpacity key="settings" style={styles.headerButton} onPress={() => router.push('/settings')}>
                                <Ionicons name="settings-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                            </TouchableOpacity>,
                            <TouchableOpacity key="profile" style={styles.headerButton} onPress={() => router.push('/profile')}>
                                <Image
                                    source={{ uri: user?.avatar || 'https://via.placeholder.com/32' }}
                                    style={styles.headerAvatar}
                                />
                            </TouchableOpacity>
                        ]
                    }}
                />

                {/* Tab Navigation */}
                <View style={styles.tabContainer}>
                    <View style={styles.tabsRow}>
                        {tabs.map((t) => (
                            <View key={t.key} style={{ flex: 1 }}>
                                {renderTabButton(t.key, t.label)}
                            </View>
                        ))}
                    </View>
                </View>

                {/* Conditional rendering based on authentication */}
                {isAuthenticated ? (
                    <>
                        {/* Feed */}
                        {String(activeTab).startsWith('custom:') ? (
                            (() => {
                                const id = String(activeTab).split(':')[1];
                                const feed = pinnedCustomFeeds.find((f) => f.id === id);
                                return (
                                    <Feed
                                        type={'mixed' as any}
                                        onSavePress={handleSavePress}
                                        filters={{ authors: (feed?.memberOxyUserIds || []).join(','), keywords: (feed?.keywords || []).join(','), includeReplies: feed?.includeReplies, includeReposts: feed?.includeReposts, includeMedia: feed?.includeMedia, language: feed?.language }}
                                    />
                                );
                            })()
                        ) : String(activeTab).startsWith('list:') ? (
                            (() => {
                                const id = String(activeTab).split(':')[1];
                                const list = pinnedLists.find((l) => l.id === id);
                                return (
                                    <Feed type={'mixed' as any} onSavePress={handleSavePress} filters={{ authors: (list?.memberOxyUserIds || []).join(',') }} recycleItems={true} maintainVisibleContentPosition={true} />
                                );
                            })()
                        ) : (
                            <Feed
                                type={activeTab as any}
                                onSavePress={handleSavePress}
                            />
                        )}

                        {/* Floating Action Button */}
                        <TouchableOpacity style={styles.fab} onPress={handleComposePress}>
                            <Ionicons name="add" size={24} color={colors.COLOR_BLACK_LIGHT_9} />
                        </TouchableOpacity>
                    </>
                ) : (
                    /* Sign-in prompt when not authenticated */
                    <SignInPrompt />
                )}
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerButton: {
        padding: 8,
        marginLeft: 8,
    },
    headerAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
    },
    tabContainer: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    tabsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        width: '100%',
    },
    tabButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
    },
    activeTabButton: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primaryColor,
    },
    tabLabel: {
        marginLeft: 6,
        fontSize: 14,
        fontWeight: '500',
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    activeTabLabel: {
        color: colors.primaryColor,
        fontWeight: '600',
    },
    fab: {
        position: 'absolute',
        bottom: 24,
        right: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        ...shadowStyle({ elevation: 8, web: `0px 4px 8px ${colors.shadow}` }),
        ...Platform.select({
            web: {
                position: 'sticky',
                bottom: 24,
                right: 24,
                marginLeft: 'auto',
                marginRight: '24px',
                marginTop: 'auto',
                marginBottom: '24px',
            },
        }),
    },
});

export default MainFeedScreen;
