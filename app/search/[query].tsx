import React, { useState, useEffect, useCallback } from "react";
import { View, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import api from "@/utils/api";
import { Loading } from "@/assets/icons/loading-icon";
import { useTranslation } from "react-i18next";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import Post from "@/components/Post";
import Avatar from "@/components/Avatar";
import { colors } from "@/styles/colors";
import { SafeAreaView } from "react-native-safe-area-context";

type SearchResultType = "all" | "users" | "posts";

const SearchResultsScreen = () => {
    const { query } = useLocalSearchParams<{ query: string }>();
    const [searchText, setSearchText] = useState(query || "");
    const [activeTab, setActiveTab] = useState<SearchResultType>("all");
    const [results, setResults] = useState<any>({ users: [], posts: [] });
    const [loading, setLoading] = useState(true);
    const { t } = useTranslation();
    const router = useRouter();

    useEffect(() => {
        const fetchResults = async () => {
            if (!searchText) return;
            try {
                setLoading(true);
                const response = await api.get(
                    `/search?query=${encodeURIComponent(searchText)}&type=${activeTab}`
                );
                setResults(response.data);
            } catch (error) {
                console.error("Error fetching search results:", error);
            } finally {
                setLoading(false);
            }
        };
        fetchResults();
    }, [searchText, activeTab]);

    const renderTabs = () => (
        <View style={styles.tabs}>
            {[
                { id: "all", label: t("All") },
                { id: "users", label: t("Users") },
                { id: "posts", label: t("Posts") },
            ].map((tab) => (
                <TouchableOpacity
                    key={tab.id}
                    style={[styles.tab, activeTab === tab.id && styles.activeTab]}
                    onPress={() => setActiveTab(tab.id as SearchResultType)}
                >
                    <ThemedText
                        style={[
                            styles.tabText,
                            activeTab === tab.id && styles.activeTabText,
                        ]}
                    >
                        {tab.label}
                    </ThemedText>
                </TouchableOpacity>
            ))}
        </View>
    );

    const renderUserItem = useCallback(
        (item: any) => (
            <TouchableOpacity
                style={styles.userItem}
                onPress={() => router.push(`/@${item.username}`)}
            >
                <Avatar size={40} id={item.avatar} />
                <View style={styles.userInfo}>
                    <ThemedText style={styles.username}>{item.username}</ThemedText>
                    {item.description && (
                        <ThemedText style={styles.email}>
                            {item.description}
                        </ThemedText>
                    )}
                </View>
            </TouchableOpacity>
        ),
        [router]
    );

    const renderPostItem = useCallback((item: any) => <Post postData={item} />, []);

    const renderProfileItem = useCallback(
        (item: any) => (
            <TouchableOpacity
                style={styles.profileItem}
                onPress={() => router.push(`/${item.username}`)}
            >
                <Avatar size={40} id={item.avatarId} />
                <View style={styles.profileInfo}>
                    <ThemedText style={styles.displayName}>
                        {item.displayName}
                    </ThemedText>
                    <ThemedText style={styles.bio} numberOfLines={2}>
                        {item.bio}
                    </ThemedText>
                </View>
            </TouchableOpacity>
        ),
        [router]
    );

    const renderItem = useCallback(
        ({ item }: { item: any }) => {
            if ("username" in item) {
                return renderUserItem(item);
            }
            if ("text" in item) {
                return renderPostItem(item);
            }
            return renderProfileItem(item);
        },
        [renderUserItem, renderPostItem, renderProfileItem]
    );

    const currentResults =
        activeTab === "all"
            ? [...results.users, ...results.posts]
            : results[activeTab] || [];

    const renderEmpty = () => (
        <View style={styles.noResults}>
            <ThemedText>{t("No results found")}</ThemedText>
        </View>
    );

    const renderContent = () => {
        if (loading) {
            return (
                <View style={styles.loader}>
                    <Loading size={30} />
                </View>
            );
        }
        return (
            <FlatList
                data={currentResults}
                keyExtractor={(item) => item._id || item.id}
                renderItem={renderItem}
                ListEmptyComponent={renderEmpty}
            />
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            {renderTabs()}
            {renderContent()}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    tabs: {
        flexDirection: "row",
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    tab: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        marginRight: 8,
    },
    activeTab: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primaryColor,
    },
    tabText: {
        fontSize: 14,
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: "600",
    },
    loader: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    noResults: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingTop: 32,
    },
    userItem: {
        flexDirection: "row",
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryLight,
    },
    userInfo: {
        marginLeft: 12,
        flex: 1,
    },
    username: {
        fontWeight: "600",
        fontSize: 16,
    },
    email: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    profileItem: {
        flexDirection: "row",
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryLight,
    },
    profileInfo: {
        marginLeft: 12,
        flex: 1,
    },
    displayName: {
        fontWeight: "600",
        fontSize: 16,
    },
    bio: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
});

export default SearchResultsScreen;