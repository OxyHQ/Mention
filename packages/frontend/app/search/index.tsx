import React, { useState, useEffect, useCallback, useRef } from "react";
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { HeaderIconButton } from "@/components/HeaderIconButton";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTheme } from "@/hooks/useTheme";
import { searchService } from "@/services/searchService";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import PostItem from "@/components/Feed/PostItem";
import { Search } from "@/assets/icons/search-icon";
import SEO from "@/components/SEO";
import { ProfileCard, type ProfileCardData } from "@/components/ProfileCard";
import { FeedCard, type FeedCardData } from "@/components/FeedCard";
import { ListCard as ListCardComponent, type ListCardData } from "@/components/ListCard";
import { Divider } from "@/components/Divider";
import { useOxy } from "@oxyhq/services";
import { EmptyState } from "@/components/common/EmptyState";

type SearchTab = "all" | "posts" | "users" | "feeds" | "hashtags" | "lists" | "saved";

type LocalSearchResults = {
    posts: any[];
    users: any[];
    feeds: any[];
    hashtags: any[];
    lists: any[];
    saved: any[];
};

export default function SearchIndex() {
    const { t } = useTranslation();
    const theme = useTheme();
    const params = useLocalSearchParams();
    const urlQuery = (params.q as string) || "";
    const { oxyServices } = useOxy();

    const [query, setQuery] = useState(urlQuery);
    const [activeTab, setActiveTab] = useState<SearchTab>("all");
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<LocalSearchResults>({
        posts: [],
        users: [],
        feeds: [],
        hashtags: [],
        lists: [],
        saved: [],
    });
    // Cache results per tab per query to avoid refetching when switching tabs
    // Also limits cache size to prevent memory issues
    const [resultsCache, setResultsCache] = useState<Record<string, LocalSearchResults>>({});
    const resultsCacheRef = useRef<Record<string, LocalSearchResults>>({});
    const MAX_CACHE_SIZE = 50; // Limit cache entries

    // Sync ref with state
    useEffect(() => {
        resultsCacheRef.current = resultsCache;
    }, [resultsCache]);

    // Helper to clean up old cache entries when cache gets too large
    // Uses LRU-style eviction (keeps most recently used entries)
    const cleanupCache = useCallback((newCache: Record<string, LocalSearchResults>) => {
        const entries = Object.entries(newCache);
        if (entries.length > MAX_CACHE_SIZE) {
            // Keep the most recent MAX_CACHE_SIZE entries
            // In a production app, you might want to track access times for true LRU
            const toKeep = entries.slice(-MAX_CACHE_SIZE);
            return Object.fromEntries(toKeep);
        }
        return newCache;
    }, []);

    // Initialize query from URL parameter
    useEffect(() => {
        if (urlQuery) {
            setQuery(urlQuery);
        }
    }, [urlQuery]);

    // Clear results when query is empty
    useEffect(() => {
        if (!query.trim()) {
            setResults({
                posts: [],
                users: [],
                feeds: [],
                hashtags: [],
                lists: [],
                saved: [],
            });
            setResultsCache({});
        }
    }, [query]);

    // Debounced search - checks cache first, reuses "all" results when possible
    useEffect(() => {
        const performSearch = async () => {
            const searchQuery = query.trim();
            if (!searchQuery) {
                setResults({
                    posts: [],
                    users: [],
                    feeds: [],
                    hashtags: [],
                    lists: [],
                    saved: [],
                });
                return;
            }

            const cacheKey = `${activeTab}-${searchQuery}`;
            // Load from cache if exists - no need to fetch again
            if (resultsCacheRef.current[cacheKey]) {
                setResults(resultsCacheRef.current[cacheKey]);
                return;
            }

            // For individual tabs, check if "all" tab has cached results for this query
            // If so, reuse those results instead of fetching again
            if (activeTab !== "all") {
                const allCacheKey = `all-${searchQuery}`;
                const allCached = resultsCacheRef.current[allCacheKey];
                if (allCached) {
                    // Use results from "all" tab for this specific tab type
                    let tabResults: LocalSearchResults = { ...results };
                    if (activeTab === "posts") {
                        tabResults = { ...results, posts: allCached.posts || [] };
                    } else if (activeTab === "users") {
                        tabResults = { ...results, users: allCached.users || [] };
                    } else if (activeTab === "feeds") {
                        tabResults = { ...results, feeds: allCached.feeds || [] };
                    } else if (activeTab === "hashtags") {
                        tabResults = { ...results, hashtags: allCached.hashtags || [] };
                    } else if (activeTab === "lists") {
                        tabResults = { ...results, lists: allCached.lists || [] };
                    } else if (activeTab === "saved") {
                        tabResults = { ...results, saved: allCached.saved || [] };
                    }

                    // Cache this tab's results (derived from "all")
                    const updatedCache = {
                        ...resultsCacheRef.current,
                        [cacheKey]: tabResults
                    };
                    setResultsCache(prev => cleanupCache(updatedCache));
                    setResults(tabResults);
                    return;
                }
            }

            setLoading(true);
            try {
                let newResults: LocalSearchResults = { ...results };
                
                if (activeTab === "all") {
                    // "all" tab fetches everything - most comprehensive
                    const allResults = await searchService.searchAll(searchQuery);
                    newResults = {
                        posts: allResults.posts || [],
                        users: allResults.users || [],
                        feeds: allResults.feeds || [],
                        hashtags: allResults.hashtags || [],
                        lists: allResults.lists || [],
                        saved: allResults.saved || [],
                    };

                    // Pre-populate cache for individual tabs using "all" results
                    // This allows instant switching to other tabs without fetching
                    const updatedCache: Record<string, LocalSearchResults> = {
                        ...resultsCacheRef.current,
                        [cacheKey]: newResults,
                    };

                    // Pre-populate individual tab caches from "all" results
                    if (!updatedCache[`posts-${searchQuery}`]) {
                        updatedCache[`posts-${searchQuery}`] = { ...results, posts: newResults.posts };
                    }
                    if (!updatedCache[`users-${searchQuery}`]) {
                        updatedCache[`users-${searchQuery}`] = { ...results, users: newResults.users };
                    }
                    if (!updatedCache[`feeds-${searchQuery}`]) {
                        updatedCache[`feeds-${searchQuery}`] = { ...results, feeds: newResults.feeds };
                    }
                    if (!updatedCache[`hashtags-${searchQuery}`]) {
                        updatedCache[`hashtags-${searchQuery}`] = { ...results, hashtags: newResults.hashtags };
                    }
                    if (!updatedCache[`lists-${searchQuery}`]) {
                        updatedCache[`lists-${searchQuery}`] = { ...results, lists: newResults.lists };
                    }
                    if (!updatedCache[`saved-${searchQuery}`]) {
                        updatedCache[`saved-${searchQuery}`] = { ...results, saved: newResults.saved };
                    }

                    setResultsCache(prev => cleanupCache(updatedCache));
                } else if (activeTab === "posts") {
                    const posts = await searchService.searchPosts(searchQuery);
                    newResults = { ...results, posts: posts || [] };
                } else if (activeTab === "users") {
                    const users = await searchService.searchUsers(searchQuery);
                    newResults = { ...results, users: users || [] };
                } else if (activeTab === "feeds") {
                    const feeds = await searchService.searchFeeds(searchQuery);
                    newResults = { ...results, feeds: feeds || [] };
                } else if (activeTab === "hashtags") {
                    const hashtags = await searchService.searchHashtags(searchQuery);
                    newResults = { ...results, hashtags: hashtags || [] };
                } else if (activeTab === "lists") {
                    const lists = await searchService.searchLists(searchQuery);
                    newResults = { ...results, lists: lists || [] };
                } else if (activeTab === "saved") {
                    const saved = await searchService.searchSaved(searchQuery);
                    newResults = { ...results, saved: saved || [] };
                }

                // Cache the results for this tab+query combination
                const updatedCache = {
                    ...resultsCacheRef.current,
                    [cacheKey]: newResults
                };
                setResultsCache(prev => cleanupCache(updatedCache));
                setResults(newResults);
            } catch (error) {
                console.warn("Search error:", error);
            } finally {
                setLoading(false);
            }
        };

        const timeoutId = setTimeout(performSearch, 500);
        return () => clearTimeout(timeoutId);
    }, [query, activeTab, cleanupCache]);

    const renderUserItem = (user: any) => {
        // Extract display name similar to MentionPicker
        let displayName = user.username || user.handle;
        if (typeof user.name === 'string') {
            displayName = user.name;
        } else if (user.name?.full) {
            displayName = user.name.full;
        } else if (user.name?.first) {
            displayName = `${user.name.first} ${user.name.last || ''}`.trim();
        } else if (user.displayName) {
            displayName = user.displayName;
        }

        const username = user.username || user.handle || '';
        
        // Get avatar URL using oxyServices
        const avatarUri = user?.avatar && oxyServices?.getFileDownloadUrl
            ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb')
            : undefined;

        const profileData: ProfileCardData = {
            id: String(user.id || user.username || ''),
            username,
            displayName,
            avatar: avatarUri || undefined,
            verified: user.verified || false,
            description: user.bio,
        };

        return (
            <View key={user.id || user.username} style={styles.userItemWrapper}>
                <ProfileCard
                    profile={profileData}
                onPress={() => router.push(`/@${username}`)}
                    style={styles.profileCardStyle}
                />
                </View>
        );
    };

    const renderFeedItem = (feed: any) => {
        const feedData: FeedCardData = {
            id: String(feed.id || feed._id || ''),
            uri: feed.uri || `feed:${feed.id || feed._id}`,
            displayName: feed.title || feed.displayName || 'Untitled Feed',
            description: feed.description,
            avatar: feed.avatar,
            creator: feed.creator ? {
                username: feed.creator.username || feed.creator.handle || '',
                displayName: feed.creator.displayName,
                avatar: feed.creator.avatar,
            } : feed.owner ? {
                username: feed.owner.username || feed.owner.handle || '',
                displayName: feed.owner.displayName,
                avatar: feed.owner.avatar,
            } : undefined,
            likeCount: feed.likeCount,
            subscriberCount: feed.subscriberCount || feed.memberCount,
        };

        return (
            <View key={feed.id} style={styles.feedItemWrapper}>
                <FeedCard
                    feed={feedData}
            onPress={() => router.push(`/feeds/${feed.id}`)}
                />
            </View>
    );
    };

    const renderHashtagItem = (hashtag: any) => (
        <View key={hashtag.tag}>
        <TouchableOpacity
                style={styles.hashtagItem}
            onPress={() => router.push(`/hashtag/${hashtag.tag}`)}
        >
            <Text style={[styles.hashtagText, { color: theme.colors.primary }]}>
                #{hashtag.tag}
            </Text>
            <Text style={[styles.hashtagCount, { color: theme.colors.textSecondary }]}>
                {hashtag.count || 0} posts
            </Text>
        </TouchableOpacity>
            <Divider />
        </View>
    );

    const renderListItem = (list: any) => {
        const owner = list.owner || list.createdBy || list.creator;
        const listData: ListCardData = {
            id: String(list.id || list._id || ''),
            uri: list.uri || `list:${list.id || list._id}`,
            name: list.name || list.title || 'Untitled List',
            description: list.description,
            avatar: list.avatar,
            creator: owner ? {
                username: owner.username || owner.handle || '',
                displayName: owner.displayName,
                avatar: owner.avatar,
            } : undefined,
            purpose: list.purpose === 'modlist' ? 'modlist' : 'curatelist',
            itemCount: list.itemCount || list.memberCount || 0,
        };

        return (
            <View key={list.id} style={styles.listItemWrapper}>
                <ListCardComponent
                    list={listData}
            onPress={() => router.push(`/lists/${list.id}`)}
                />
            </View>
    );
    };

    const tabs = [
        { id: "all", label: t("search.tabs.all", "All") },
        { id: "posts", label: t("search.tabs.posts", "Posts") },
        { id: "users", label: t("search.tabs.users", "Users") },
        { id: "saved", label: t("search.tabs.saved", "Saved") },
        { id: "feeds", label: t("search.tabs.feeds", "Feeds") },
        { id: "hashtags", label: t("search.tabs.hashtags", "Hashtags") },
        { id: "lists", label: t("search.tabs.lists", "Lists") },
    ];

    const hasResults =
        results.posts.length > 0 ||
        results.users.length > 0 ||
        results.feeds.length > 0 ||
        results.hashtags.length > 0 ||
        results.lists.length > 0 ||
        results.saved.length > 0;

    return (
        <>
            <SEO
                title={t('seo.search.title')}
                description={t('seo.search.description')}
            />
            <ThemedView style={styles.container}>
                <SafeAreaView style={styles.safeArea} edges={["top"]}>
                    <Header
                        options={{
                            title: t("search.title", "Search"),
                            leftComponents: [
                                <HeaderIconButton
                                    key="back"
                                    onPress={() => router.back()}
                                >
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </HeaderIconButton>,
                            ],
                            rightComponents: [
                                <HeaderIconButton
                                    key="filter"
                                    onPress={() => {
                                        // TODO: Add filter functionality
                                    }}
                                >
                                    <Ionicons name="options-outline" size={20} color={theme.colors.text} />
                                </HeaderIconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                    />

                <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <View style={styles.searchIcon}>
                        <Search
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                    </View>
                    <TextInput
                        style={[styles.searchInput, { color: theme.colors.text }]}
                        placeholder={t("search.placeholder", "Search...")}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={query}
                        onChangeText={setQuery}
                        autoFocus
                    />
                    {query.length > 0 && (
                        <TouchableOpacity onPress={() => setQuery("")}>
                            <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                    )}
                </View>

                <AnimatedTabBar
                    tabs={tabs}
                    activeTabId={activeTab}
                    onTabPress={(id: string) => setActiveTab(id as SearchTab)}
                    scrollEnabled={true}
                />

                <ScrollView style={styles.resultsContainer}>
                    {loading && (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={theme.colors.primary} />
                        </View>
                    )}

                    {!loading && query.trim() && !hasResults && (
                        <EmptyState
                            title={t("search.noResults", "No results found")}
                            icon={{
                                name: 'search-outline',
                                size: 48,
                            }}
                        />
                    )}

                    {!loading && !query.trim() && (
                        <EmptyState
                            title={t("search.startSearching", "Start searching")}
                            icon={{
                                name: 'search-outline',
                                size: 48,
                            }}
                        />
                    )}

                    {!loading && hasResults && (
                        <>
                            {(activeTab === "all" || activeTab === "posts") && results.posts.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.posts", "Posts")}
                                    </Text>
                                    {results.posts.map((post: any) => (
                                        <PostItem key={post.id} post={post} />
                                    ))}
                                </View>
                            )}

                            {(activeTab === "all" || activeTab === "users") && results.users.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.users", "Users")}
                                    </Text>
                                    {results.users.map(renderUserItem)}
                                </View>
                            )}

                            {(activeTab === "all" || activeTab === "saved") && results.saved.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.saved", "Saved")}
                                    </Text>
                                    {results.saved.map((post: any) => (
                                        <PostItem key={post.id || post._id} post={post} />
                                    ))}
                                </View>
                            )}

                            {(activeTab === "all" || activeTab === "feeds") && results.feeds.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.feeds", "Feeds")}
                                    </Text>
                                    {results.feeds.map(renderFeedItem)}
                                </View>
                            )}

                            {(activeTab === "all" || activeTab === "hashtags") && results.hashtags.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.hashtags", "Hashtags")}
                                    </Text>
                                    {results.hashtags.map(renderHashtagItem)}
                                </View>
                            )}

                            {(activeTab === "all" || activeTab === "lists") && results.lists.length > 0 && (
                                <View style={styles.section}>
                                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                        {t("search.sections.lists", "Lists")}
                                    </Text>
                                    {results.lists.map(renderListItem)}
                                </View>
                            )}

                            {activeTab === "saved" && results.saved.length > 0 && (
                                <View style={styles.section}>
                                    {results.saved.map((post: any) => (
                                        <PostItem key={post.id || post._id} post={post} />
                                    ))}
                                </View>
                            )}
                        </>
                    )}
                </ScrollView>
            </SafeAreaView>
        </ThemedView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    safeArea: {
        flex: 1,
    },
    searchContainer: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 8,
        marginHorizontal: 16,
        marginVertical: 8,
        borderRadius: 24,
    },
    searchIcon: {
        marginRight: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
        paddingVertical: 8,
    },
    resultsContainer: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingTop: 60,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: "600",
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    userItemWrapper: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    profileCardStyle: {
        borderWidth: 0,
        padding: 0,
    },
    feedItemWrapper: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    listItemWrapper: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    hashtagItem: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        padding: 16,
    },
    hashtagText: {
        fontSize: 16,
        fontWeight: "600",
    },
    hashtagCount: {
        fontSize: 14,
    },
});
