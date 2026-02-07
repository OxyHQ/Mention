import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTheme } from "@/hooks/useTheme";
import { searchService } from "@/services/searchService";
import { Loading } from "@/components/ui/Loading";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import PostItem from "@/components/Feed/PostItem";
import { Search } from "@/assets/icons/search-icon";
import SEO from "@/components/SEO";
import { ProfileCard, type ProfileCardData } from "@/components/ProfileCard";
import { FeedCard, type FeedCardData } from "@/components/FeedCard";
import { ListCard as ListCardComponent, type ListCardData } from "@/components/ListCard";
import { Divider } from "@/components/Divider";
import { EmptyState } from "@/components/common/EmptyState";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";

type SearchTab = "all" | "posts" | "users" | "feeds" | "hashtags" | "lists" | "saved";

type LocalSearchResults = {
    posts: any[];
    users: any[];
    feeds: any[];
    hashtags: any[];
    lists: any[];
    saved: any[];
};

const EMPTY_RESULTS: LocalSearchResults = {
    posts: [],
    users: [],
    feeds: [],
    hashtags: [],
    lists: [],
    saved: [],
};

export default function SearchIndex() {
    const { t } = useTranslation();
    const theme = useTheme();
    const params = useLocalSearchParams();
    const urlQuery = (params.q as string) || "";

    const [query, setQuery] = useState(urlQuery);
    const [activeTab, setActiveTab] = useState<SearchTab>("all");
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<LocalSearchResults>(EMPTY_RESULTS);
    const [resultsCache, setResultsCache] = useState<Record<string, LocalSearchResults>>({});
    const resultsCacheRef = useRef<Record<string, LocalSearchResults>>({});
    const MAX_CACHE_SIZE = 50;
    const searchInputRef = useRef<TextInput>(null);

    useEffect(() => {
        resultsCacheRef.current = resultsCache;
    }, [resultsCache]);

    const cleanupCache = useCallback((newCache: Record<string, LocalSearchResults>) => {
        const entries = Object.entries(newCache);
        if (entries.length > MAX_CACHE_SIZE) {
            const toKeep = entries.slice(-MAX_CACHE_SIZE);
            return Object.fromEntries(toKeep);
        }
        return newCache;
    }, []);

    useEffect(() => {
        if (urlQuery) {
            setQuery(urlQuery);
        }
    }, [urlQuery]);

    useEffect(() => {
        if (!query.trim()) {
            setResults(EMPTY_RESULTS);
            setResultsCache({});
        }
    }, [query]);

    // Debounced search with cache
    useEffect(() => {
        const performSearch = async () => {
            const searchQuery = query.trim();
            if (!searchQuery) {
                setResults(EMPTY_RESULTS);
                return;
            }

            const cacheKey = `${activeTab}-${searchQuery}`;
            if (resultsCacheRef.current[cacheKey]) {
                setResults(resultsCacheRef.current[cacheKey]);
                return;
            }

            // Reuse "all" tab results for individual tabs
            if (activeTab !== "all") {
                const allCacheKey = `all-${searchQuery}`;
                const allCached = resultsCacheRef.current[allCacheKey];
                if (allCached) {
                    const tabResults: LocalSearchResults = {
                        ...EMPTY_RESULTS,
                        [activeTab]: allCached[activeTab] || [],
                    };
                    const updatedCache = {
                        ...resultsCacheRef.current,
                        [cacheKey]: tabResults,
                    };
                    setResultsCache(cleanupCache(updatedCache));
                    setResults(tabResults);
                    return;
                }
            }

            setLoading(true);
            try {
                let newResults: LocalSearchResults;

                if (activeTab === "all") {
                    const allResults = await searchService.searchAll(searchQuery);
                    newResults = {
                        posts: allResults.posts || [],
                        users: allResults.users || [],
                        feeds: allResults.feeds || [],
                        hashtags: allResults.hashtags || [],
                        lists: allResults.lists || [],
                        saved: allResults.saved || [],
                    };

                    // Pre-populate individual tab caches
                    const updatedCache: Record<string, LocalSearchResults> = {
                        ...resultsCacheRef.current,
                        [cacheKey]: newResults,
                    };
                    const tabKeys: SearchTab[] = ["posts", "users", "feeds", "hashtags", "lists", "saved"];
                    for (const tab of tabKeys) {
                        const tabCacheKey = `${tab}-${searchQuery}`;
                        if (!updatedCache[tabCacheKey]) {
                            updatedCache[tabCacheKey] = { ...EMPTY_RESULTS, [tab]: newResults[tab] };
                        }
                    }
                    setResultsCache(cleanupCache(updatedCache));
                } else {
                    const fetchMap: Record<string, () => Promise<any>> = {
                        posts: () => searchService.searchPosts(searchQuery),
                        users: () => searchService.searchUsers(searchQuery),
                        feeds: () => searchService.searchFeeds(searchQuery),
                        hashtags: () => searchService.searchHashtags(searchQuery),
                        lists: () => searchService.searchLists(searchQuery),
                        saved: () => searchService.searchSaved(searchQuery),
                    };

                    const data = await fetchMap[activeTab]();
                    newResults = { ...EMPTY_RESULTS, [activeTab]: data || [] };

                    const updatedCache = {
                        ...resultsCacheRef.current,
                        [cacheKey]: newResults,
                    };
                    setResultsCache(cleanupCache(updatedCache));
                }

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

    const clearSearch = useCallback(() => {
        setQuery("");
        searchInputRef.current?.focus();
    }, []);

    const renderUserItem = useCallback((user: any) => {
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
        const avatarUri = user?.avatar;

        const profileData: ProfileCardData = {
            id: String(user.id || user.username || ''),
            username,
            displayName,
            avatar: avatarUri || undefined,
            verified: user.verified || false,
            description: user.bio,
        };

        return (
            <View key={user.id || user.username} style={styles.itemWrapper}>
                <ProfileCard
                    profile={profileData}
                    onPress={() => router.push(`/@${username}`)}
                    style={styles.profileCardStyle}
                />
            </View>
        );
    }, []);

    const renderFeedItem = useCallback((feed: any) => {
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
            <View key={feed.id} style={styles.itemWrapper}>
                <FeedCard
                    feed={feedData}
                    onPress={() => router.push(`/feeds/${feed.id}`)}
                />
            </View>
        );
    }, []);

    const renderHashtagItem = useCallback((hashtag: any) => (
        <View key={hashtag.tag}>
            <TouchableOpacity
                style={styles.hashtagItem}
                onPress={() => router.push(`/hashtag/${hashtag.tag}`)}
            >
                <View style={styles.hashtagLeft}>
                    <View style={[styles.hashtagIconContainer, { backgroundColor: theme.colors.primaryLight }]}>
                        <Text style={[styles.hashtagSymbol, { color: theme.colors.primary }]}>#</Text>
                    </View>
                    <View>
                        <Text style={[styles.hashtagText, { color: theme.colors.text }]}>
                            {hashtag.tag}
                        </Text>
                        <Text style={[styles.hashtagCount, { color: theme.colors.textSecondary }]}>
                            {hashtag.count || 0} {t("search.posts", "posts")}
                        </Text>
                    </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textTertiary} />
            </TouchableOpacity>
            <Divider />
        </View>
    ), [theme, t]);

    const renderListItem = useCallback((list: any) => {
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
            <View key={list.id} style={styles.itemWrapper}>
                <ListCardComponent
                    list={listData}
                    onPress={() => router.push(`/lists/${list.id}`)}
                />
            </View>
        );
    }, []);

    const tabs = useMemo(() => [
        { id: "all", label: t("search.tabs.all", "All") },
        { id: "posts", label: t("search.tabs.posts", "Posts") },
        { id: "users", label: t("search.tabs.users", "Users") },
        { id: "feeds", label: t("search.tabs.feeds", "Feeds") },
        { id: "hashtags", label: t("search.tabs.hashtags", "Hashtags") },
        { id: "lists", label: t("search.tabs.lists", "Lists") },
        { id: "saved", label: t("search.tabs.saved", "Saved") },
    ], [t]);

    const hasResults =
        results.posts.length > 0 ||
        results.users.length > 0 ||
        results.feeds.length > 0 ||
        results.hashtags.length > 0 ||
        results.lists.length > 0 ||
        results.saved.length > 0;

    // Get items for current tab
    const currentTabHasResults = useMemo(() => {
        if (activeTab === "all") return hasResults;
        return (results[activeTab]?.length || 0) > 0;
    }, [activeTab, results, hasResults]);

    const renderSection = (title: string, items: any[], renderItem: (item: any) => React.ReactNode, showTitle: boolean) => {
        if (items.length === 0) return null;
        return (
            <View style={styles.section}>
                {showTitle && (
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {title}
                    </Text>
                )}
                {items.map(renderItem)}
            </View>
        );
    };

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
                                <IconButton variant="icon"
                                    key="back"
                                    onPress={() => router.back()}
                                >
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                    />

                    <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <View style={styles.searchIcon}>
                            <Search
                                size={18}
                                color={query.trim() ? theme.colors.primary : theme.colors.textSecondary}
                            />
                        </View>
                        <TextInput
                            ref={searchInputRef}
                            style={[styles.searchInput, { color: theme.colors.text }]}
                            placeholder={t("search.placeholder", "Search...")}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={query}
                            onChangeText={setQuery}
                            autoFocus
                            returnKeyType="search"
                        />
                        {query.length > 0 && (
                            <TouchableOpacity
                                onPress={clearSearch}
                                style={styles.clearButton}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                                <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                            </TouchableOpacity>
                        )}
                    </View>

                    <AnimatedTabBar
                        tabs={tabs}
                        activeTabId={activeTab}
                        onTabPress={(id: string) => setActiveTab(id as SearchTab)}
                        scrollEnabled={true}
                    />

                    <ScrollView
                        style={styles.resultsContainer}
                        contentContainerStyle={!loading && !currentTabHasResults ? styles.resultsContentEmpty : undefined}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                    >
                        {loading && (
                            <View style={styles.loadingContainer}>
                                <Loading size="large" />
                            </View>
                        )}

                        {!loading && query.trim() && !currentTabHasResults && (
                            <EmptyState
                                title={t("search.noResults", "No results found")}
                                subtitle={t("search.tryDifferent", "Try searching for something else")}
                                icon={{
                                    name: 'search-outline',
                                    size: 48,
                                }}
                            />
                        )}

                        {!loading && !query.trim() && (
                            <EmptyState
                                title={t("search.startSearching", "Search Mention")}
                                subtitle={t("search.startDescription", "Find people, posts, hashtags, and more")}
                                icon={{
                                    name: 'search-outline',
                                    size: 48,
                                }}
                            />
                        )}

                        {!loading && currentTabHasResults && (
                            <>
                                {(activeTab === "all" || activeTab === "posts") &&
                                    renderSection(
                                        t("search.sections.posts", "Posts"),
                                        results.posts,
                                        (post: any) => <PostItem key={post.id} post={post} />,
                                        activeTab === "all",
                                    )
                                }

                                {(activeTab === "all" || activeTab === "users") &&
                                    renderSection(
                                        t("search.sections.users", "People"),
                                        results.users,
                                        renderUserItem,
                                        activeTab === "all",
                                    )
                                }

                                {(activeTab === "all" || activeTab === "feeds") &&
                                    renderSection(
                                        t("search.sections.feeds", "Feeds"),
                                        results.feeds,
                                        renderFeedItem,
                                        activeTab === "all",
                                    )
                                }

                                {(activeTab === "all" || activeTab === "hashtags") &&
                                    renderSection(
                                        t("search.sections.hashtags", "Hashtags"),
                                        results.hashtags,
                                        renderHashtagItem,
                                        activeTab === "all",
                                    )
                                }

                                {(activeTab === "all" || activeTab === "lists") &&
                                    renderSection(
                                        t("search.sections.lists", "Lists"),
                                        results.lists,
                                        renderListItem,
                                        activeTab === "all",
                                    )
                                }

                                {(activeTab === "all" || activeTab === "saved") &&
                                    renderSection(
                                        t("search.sections.saved", "Saved"),
                                        results.saved,
                                        (post: any) => <PostItem key={post.id || post._id} post={post} />,
                                        activeTab === "all",
                                    )
                                }
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
        paddingHorizontal: SPACING.base,
        paddingVertical: SPACING.sm,
        marginHorizontal: SPACING.base,
        marginVertical: SPACING.sm,
        borderRadius: 24,
    },
    searchIcon: {
        marginRight: SPACING.sm,
    },
    searchInput: {
        flex: 1,
        fontSize: FONT_SIZES.lg,
        paddingVertical: SPACING.sm,
    },
    clearButton: {
        padding: 4,
    },
    resultsContainer: {
        flex: 1,
    },
    resultsContentEmpty: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    loadingContainer: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 300,
    },
    section: {
        marginBottom: SPACING.base,
    },
    sectionTitle: {
        fontSize: FONT_SIZES.xl,
        fontWeight: "700",
        paddingHorizontal: SPACING.base,
        paddingVertical: SPACING.md,
    },
    itemWrapper: {
        paddingHorizontal: SPACING.md,
        paddingVertical: SPACING.sm,
    },
    profileCardStyle: {
        borderWidth: 0,
        padding: 0,
    },
    hashtagItem: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: SPACING.base,
        paddingVertical: SPACING.md,
    },
    hashtagLeft: {
        flexDirection: "row",
        alignItems: "center",
        gap: SPACING.md,
    },
    hashtagIconContainer: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
    },
    hashtagSymbol: {
        fontSize: FONT_SIZES["2xl"],
        fontWeight: "700",
    },
    hashtagText: {
        fontSize: FONT_SIZES.lg,
        fontWeight: "600",
    },
    hashtagCount: {
        fontSize: FONT_SIZES.sm,
        marginTop: 2,
    },
});
