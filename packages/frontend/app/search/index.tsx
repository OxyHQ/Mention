import React, { useState, useEffect } from "react";
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
import { useTheme } from "@/hooks/useTheme";
import { searchService } from "@/services/searchService";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import Avatar from "@/components/Avatar";
import PostItem from "@/components/Feed/PostItem";

type SearchTab = "all" | "posts" | "users" | "feeds" | "hashtags" | "lists";

type LocalSearchResults = {
    posts: any[];
    users: any[];
    feeds: any[];
    hashtags: any[];
    lists: any[];
};

export default function SearchIndex() {
    const { t } = useTranslation();
    const theme = useTheme();
    const params = useLocalSearchParams();
    const urlQuery = (params.q as string) || "";

    const [query, setQuery] = useState(urlQuery);
    const [activeTab, setActiveTab] = useState<SearchTab>("all");
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<LocalSearchResults>({
        posts: [],
        users: [],
        feeds: [],
        hashtags: [],
        lists: [],
    });

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
            });
        }
    }, [query]);

    // Debounced search
    useEffect(() => {
        const performSearch = async () => {
            const searchQuery = query.trim();
            if (!searchQuery) {
                return;
            }

            setLoading(true);
            try {
                if (activeTab === "all") {
                    const allResults = await searchService.searchAll(searchQuery);
                    setResults({
                        posts: allResults.posts || [],
                        users: allResults.users || [],
                        feeds: allResults.feeds || [],
                        hashtags: allResults.hashtags || [],
                        lists: allResults.lists || [],
                    });
                } else if (activeTab === "posts") {
                    const posts = await searchService.searchPosts(searchQuery);
                    setResults(prev => ({ ...prev, posts: posts || [] }));
                } else if (activeTab === "users") {
                    const users = await searchService.searchUsers(searchQuery);
                    setResults(prev => ({ ...prev, users: users || [] }));
                } else if (activeTab === "feeds") {
                    const feeds = await searchService.searchFeeds(searchQuery);
                    setResults(prev => ({ ...prev, feeds: feeds || [] }));
                } else if (activeTab === "hashtags") {
                    const hashtags = await searchService.searchHashtags(searchQuery);
                    setResults(prev => ({ ...prev, hashtags: hashtags || [] }));
                } else if (activeTab === "lists") {
                    const lists = await searchService.searchLists(searchQuery);
                    setResults(prev => ({ ...prev, lists: lists || [] }));
                }
            } catch (error) {
                console.warn("Search error:", error);
            } finally {
                setLoading(false);
            }
        };

        const timeoutId = setTimeout(performSearch, 500);
        return () => clearTimeout(timeoutId);
    }, [query, activeTab]);

    const renderUserItem = (user: any) => (
        <TouchableOpacity
            key={user.id || user.username}
            style={[styles.userItem, { borderBottomColor: theme.colors.border }]}
            onPress={() => router.push(`/${user.username}`)}
        >
            <Avatar
                source={user.avatarUrl ? { uri: user.avatarUrl } : undefined}
                size={48}
                label={user.displayName?.[0] || user.username?.[0]}
            />
            <View style={styles.userInfo}>
                <Text style={[styles.userName, { color: theme.colors.text }]}>
                    {user.displayName || user.username}
                </Text>
                <Text style={[styles.userHandle, { color: theme.colors.textSecondary }]}>
                    @{user.username}
                </Text>
                {user.bio && (
                    <Text
                        style={[styles.userBio, { color: theme.colors.textSecondary }]}
                        numberOfLines={2}
                    >
                        {user.bio}
                    </Text>
                )}
            </View>
        </TouchableOpacity>
    );

    const renderFeedItem = (feed: any) => (
        <TouchableOpacity
            key={feed.id}
            style={[styles.feedItem, { borderBottomColor: theme.colors.border }]}
            onPress={() => router.push(`/feeds/${feed.id}`)}
        >
            <View style={styles.feedInfo}>
                <Text style={[styles.feedTitle, { color: theme.colors.text }]}>
                    {feed.title}
                </Text>
                {feed.description && (
                    <Text
                        style={[styles.feedDescription, { color: theme.colors.textSecondary }]}
                        numberOfLines={2}
                    >
                        {feed.description}
                    </Text>
                )}
                <Text style={[styles.feedMeta, { color: theme.colors.textSecondary }]}>
                    {feed.memberCount || 0} members
                </Text>
            </View>
        </TouchableOpacity>
    );

    const renderHashtagItem = (hashtag: any) => (
        <TouchableOpacity
            key={hashtag.tag}
            style={[styles.hashtagItem, { borderBottomColor: theme.colors.border }]}
            onPress={() => router.push(`/hashtag/${hashtag.tag}`)}
        >
            <Text style={[styles.hashtagText, { color: theme.colors.primary }]}>
                #{hashtag.tag}
            </Text>
            <Text style={[styles.hashtagCount, { color: theme.colors.textSecondary }]}>
                {hashtag.count || 0} posts
            </Text>
        </TouchableOpacity>
    );

    const renderListItem = (list: any) => (
        <TouchableOpacity
            key={list.id}
            style={[styles.listItem, { borderBottomColor: theme.colors.border }]}
            onPress={() => router.push(`/lists/${list.id}`)}
        >
            <View style={[styles.listIcon, { backgroundColor: theme.colors.primary }]}>
                <Ionicons name="list" size={20} color={theme.colors.card} />
            </View>
            <View style={styles.listInfo}>
                <Text style={[styles.listTitle, { color: theme.colors.text }]}>
                    {list.name}
                </Text>
                {list.description && (
                    <Text
                        style={[styles.listDescription, { color: theme.colors.textSecondary }]}
                        numberOfLines={1}
                    >
                        {list.description}
                    </Text>
                )}
            </View>
        </TouchableOpacity>
    );

    const tabs = [
        { id: "all", label: t("search.tabs.all", "All") },
        { id: "posts", label: t("search.tabs.posts", "Posts") },
        { id: "users", label: t("search.tabs.users", "Users") },
        { id: "feeds", label: t("search.tabs.feeds", "Feeds") },
        { id: "hashtags", label: t("search.tabs.hashtags", "Hashtags") },
        { id: "lists", label: t("search.tabs.lists", "Lists") },
    ];

    const hasResults =
        results.posts.length > 0 ||
        results.users.length > 0 ||
        results.feeds.length > 0 ||
        results.hashtags.length > 0 ||
        results.lists.length > 0;

    return (
        <ThemedView style={styles.container}>
            <SafeAreaView style={styles.safeArea} edges={["top"]}>
                <Header
                    options={{
                        title: t("search.title", "Search"),
                        showBackButton: true,
                    }}
                />

                <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Ionicons
                        name="search"
                        size={20}
                        color={theme.colors.textSecondary}
                        style={styles.searchIcon}
                    />
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
                />

                <ScrollView style={styles.resultsContainer}>
                    {loading && (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={theme.colors.primary} />
                        </View>
                    )}

                    {!loading && query.trim() && !hasResults && (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="search" size={48} color={theme.colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t("search.noResults", "No results found")}
                            </Text>
                        </View>
                    )}

                    {!loading && !query.trim() && (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="search" size={48} color={theme.colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t("search.startSearching", "Start searching")}
                            </Text>
                        </View>
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
                        </>
                    )}
                </ScrollView>
            </SafeAreaView>
        </ThemedView>
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
    emptyContainer: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingTop: 60,
    },
    emptyText: {
        fontSize: 16,
        marginTop: 16,
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
    userItem: {
        flexDirection: "row",
        padding: 16,
        borderBottomWidth: 1,
    },
    userInfo: {
        marginLeft: 12,
        flex: 1,
    },
    userName: {
        fontSize: 16,
        fontWeight: "600",
    },
    userHandle: {
        fontSize: 14,
        marginTop: 2,
    },
    userBio: {
        fontSize: 14,
        marginTop: 4,
    },
    feedItem: {
        padding: 16,
        borderBottomWidth: 1,
    },
    feedInfo: {
        flex: 1,
    },
    feedTitle: {
        fontSize: 16,
        fontWeight: "600",
    },
    feedDescription: {
        fontSize: 14,
        marginTop: 4,
    },
    feedMeta: {
        fontSize: 12,
        marginTop: 4,
    },
    hashtagItem: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        padding: 16,
        borderBottomWidth: 1,
    },
    hashtagText: {
        fontSize: 16,
        fontWeight: "600",
    },
    hashtagCount: {
        fontSize: 14,
    },
    listItem: {
        flexDirection: "row",
        alignItems: "center",
        padding: 16,
        borderBottomWidth: 1,
    },
    listIcon: {
        width: 40,
        height: 40,
        borderRadius: 8,
        justifyContent: "center",
        alignItems: "center",
    },
    listInfo: {
        flex: 1,
        marginLeft: 12,
    },
    listTitle: {
        fontSize: 16,
        fontWeight: "600",
    },
    listDescription: {
        fontSize: 14,
        marginTop: 4,
    },
});
