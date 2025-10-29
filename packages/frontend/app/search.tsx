import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { useTheme } from "@/hooks/useTheme";
import { searchService } from "@/services/searchService";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import Avatar from "@/components/Avatar";
import PostItem from "@/components/Feed/PostItem";

type SearchTab = "all" | "posts" | "users" | "feeds" | "hashtags" | "lists";

const SearchScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("all");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any>({
    posts: [],
    users: [],
    feeds: [],
    hashtags: [],
    lists: [],
  });

  // Debounced search
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
        });
        return;
      }

      setLoading(true);
      try {
        if (activeTab === "all") {
          const allResults = await searchService.searchAll(searchQuery);
          setResults(allResults);
        } else if (activeTab === "posts") {
          const posts = await searchService.searchPosts(searchQuery);
          setResults({ ...results, posts });
        } else if (activeTab === "users") {
          const users = await searchService.searchUsers(searchQuery);
          setResults({ ...results, users });
        } else if (activeTab === "feeds") {
          const feeds = await searchService.searchFeeds(searchQuery);
          setResults({ ...results, feeds });
        } else if (activeTab === "hashtags") {
          const hashtags = await searchService.searchHashtags(searchQuery);
          setResults({ ...results, hashtags });
        } else if (activeTab === "lists") {
          const lists = await searchService.searchLists(searchQuery);
          setResults({ ...results, lists });
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
      key={feed._id || feed.id}
      style={[styles.feedItem, { borderBottomColor: theme.colors.border }]}
      onPress={() => router.push(`/feeds/${feed._id || feed.id}`)}
    >
      <View style={[styles.feedIcon, { backgroundColor: theme.colors.primary }]}>
        <Ionicons name="filter" size={20} color={theme.colors.card} />
      </View>
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
      </View>
    </TouchableOpacity>
  );

  const renderHashtagItem = (hashtag: any) => (
    <TouchableOpacity
      key={hashtag._id || hashtag.name}
      style={[styles.hashtagItem, { borderBottomColor: theme.colors.border }]}
      onPress={() => router.push(`/hashtag/${hashtag.name || hashtag}`)}
    >
      <View style={[styles.hashtagIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Text style={styles.hashtagSymbol}>#</Text>
      </View>
      <View style={styles.hashtagInfo}>
        <Text style={[styles.hashtagName, { color: theme.colors.text }]}>
          #{hashtag.name || hashtag}
        </Text>
        {hashtag.count && (
          <Text style={[styles.hashtagCount, { color: theme.colors.textSecondary }]}>
            {hashtag.count} posts
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderListItem = (list: any) => (
    <TouchableOpacity
      key={list._id || list.id}
      style={[styles.listItem, { borderBottomColor: theme.colors.border }]}
      onPress={() => router.push(`/lists/${list._id || list.id}`)}
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
            numberOfLines={2}
          >
            {list.description}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Ionicons name="search-outline" size={64} color={theme.colors.textSecondary} />
      <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
        {query.trim()
          ? `No results found for "${query}"`
          : "Search for posts, users, feeds, hashtags, and lists"}
      </Text>
    </View>
  );

  const renderContent = () => {
    if (loading) {
      return (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      );
    }

    if (!query.trim()) {
      return renderEmptyState();
    }

    const hasResults =
      (activeTab === "all" || activeTab === "posts") && results.posts?.length > 0 ||
      (activeTab === "all" || activeTab === "users") && results.users?.length > 0 ||
      (activeTab === "all" || activeTab === "feeds") && results.feeds?.length > 0 ||
      (activeTab === "all" || activeTab === "hashtags") && results.hashtags?.length > 0 ||
      (activeTab === "all" || activeTab === "lists") && results.lists?.length > 0;

    if (!hasResults) {
      return renderEmptyState();
    }

    return (
      <ScrollView style={styles.resultsContainer} showsVerticalScrollIndicator={false}>
        {/* Posts */}
        {(activeTab === "all" || activeTab === "posts") && results.posts?.length > 0 && (
          <View style={styles.section}>
            {activeTab === "all" && (
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Posts</Text>
            )}
            {results.posts.map((post: any) => (
              <PostItem key={post._id} post={post} />
            ))}
          </View>
        )}

        {/* Users */}
        {(activeTab === "all" || activeTab === "users") && results.users?.length > 0 && (
          <View style={styles.section}>
            {activeTab === "all" && (
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Users</Text>
            )}
            {results.users.map(renderUserItem)}
          </View>
        )}

        {/* Feeds */}
        {(activeTab === "all" || activeTab === "feeds") && results.feeds?.length > 0 && (
          <View style={styles.section}>
            {activeTab === "all" && (
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Feeds</Text>
            )}
            {results.feeds.map(renderFeedItem)}
          </View>
        )}

        {/* Hashtags */}
        {(activeTab === "all" || activeTab === "hashtags") && results.hashtags?.length > 0 && (
          <View style={styles.section}>
            {activeTab === "all" && (
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Hashtags</Text>
            )}
            {results.hashtags.map(renderHashtagItem)}
          </View>
        )}

        {/* Lists */}
        {(activeTab === "all" || activeTab === "lists") && results.lists?.length > 0 && (
          <View style={styles.section}>
            {activeTab === "all" && (
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Lists</Text>
            )}
            {results.lists.map(renderListItem)}
          </View>
        )}
      </ScrollView>
    );
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={["top"]}
    >
      <ThemedView style={{ flex: 1 }}>
        {/* Header */}
        <Header
          options={{
            title: t("Search"),
            leftComponents: [
              <TouchableOpacity
                key="back"
                onPress={() => router.back()}
                style={{ padding: 8 }}
              >
                <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
              </TouchableOpacity>,
            ],
          }}
        />

        {/* Search Input */}
        <View
          style={[
            styles.searchBox,
            {
              backgroundColor: theme.colors.backgroundSecondary,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Ionicons name="search" size={20} color={theme.colors.textSecondary} />
          <TextInput
            placeholder={t("Search Mention")}
            value={query}
            onChangeText={setQuery}
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholderTextColor={theme.colors.textSecondary}
            autoFocus
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Tab Bar */}
        <AnimatedTabBar
          tabs={[
            { id: "all", label: t("All") },
            { id: "posts", label: t("Posts") },
            { id: "users", label: t("Users") },
            { id: "feeds", label: t("Feeds") },
            { id: "hashtags", label: t("Hashtags") },
            { id: "lists", label: t("Lists") },
          ]}
          activeTabId={activeTab}
          onTabPress={(tab: string) => setActiveTab(tab as SearchTab)}
        />

        {/* Content */}
        {renderContent()}
      </ThemedView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 40,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyStateText: {
    fontSize: 16,
    textAlign: "center",
    marginTop: 16,
  },
  resultsContainer: {
    flex: 1,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  userItem: {
    flexDirection: "row",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  userInfo: {
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
    flexDirection: "row",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    alignItems: "center",
  },
  feedIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
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
  hashtagItem: {
    flexDirection: "row",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    alignItems: "center",
  },
  hashtagIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  hashtagSymbol: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#d169e5",
  },
  hashtagInfo: {
    flex: 1,
  },
  hashtagName: {
    fontSize: 16,
    fontWeight: "600",
  },
  hashtagCount: {
    fontSize: 14,
    marginTop: 2,
  },
  listItem: {
    flexDirection: "row",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    alignItems: "center",
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

export default SearchScreen;
