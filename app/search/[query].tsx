import React, { useState, useEffect } from "react";
import { View, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from 'expo-router';
import api from "@/utils/api";
import { Loading } from "@/assets/icons/loading-icon";
import { useTranslation } from "react-i18next";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import Post from "@/components/Post";
import Avatar from "@/components/Avatar";
import { colors } from "@/styles/colors";

type SearchResultType = "all" | "users" | "posts" | "profiles";

const SearchResultsScreen = () => {
    const { query } = useLocalSearchParams<{ query: string }>();
    const [searchText, setSearchText] = useState(query || "");
    const [activeTab, setActiveTab] = useState<SearchResultType>("all");
    const [results, setResults] = useState<any>({ users: [], posts: [], profiles: [] });
    const [loading, setLoading] = useState(true);
    const { t } = useTranslation();
    const router = useRouter();

    useEffect(() => {
        const fetchResults = async () => {
            if (!searchText) return;
            try {
                setLoading(true);
                const response = await api.get(`/search?query=${encodeURIComponent(searchText)}&type=${activeTab}`);
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
            {["all", "users", "posts", "profiles"].map((tab) => (
                <TouchableOpacity
                    key={tab}
                    style={[styles.tab, activeTab === tab && styles.activeTab]}
                    onPress={() => setActiveTab(tab as SearchResultType)}
                >
                    <ThemedText style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
                        {t(tab.charAt(0).toUpperCase() + tab.slice(1))}
                    </ThemedText>
                </TouchableOpacity>
            ))}
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

        const currentResults = activeTab === "all" ? 
            [...results.users, ...results.posts, ...results.profiles] :
            results[activeTab];

        if (currentResults.length === 0) {
            return (
                <View style={styles.noResults}>
                    <ThemedText>{t("No results found")}</ThemedText>
                </View>
            );
        }

        return (
            <FlatList
                data={currentResults}
                keyExtractor={(item) => item._id || item.id}
                renderItem={({ item }) => {
                    if ("username" in item) {
                        return (
                            <TouchableOpacity 
                                style={styles.userItem}
                                onPress={() => router.push(`/@${item.username}`)}
                            >
                                <Avatar size={40} id={item.avatarId} />
                                <View style={styles.userInfo}>
                                    <ThemedText style={styles.username}>{item.username}</ThemedText>
                                    <ThemedText style={styles.email}>{item.email}</ThemedText>
                                </View>
                            </TouchableOpacity>
                        );
                    }
                    if ("text" in item) {
                        return <Post postData={item} />;
                    }
                    // Profile result
                    return (
                        <TouchableOpacity 
                            style={styles.profileItem}
                            onPress={() => router.push(`/${item.username}`)}
                        >
                            <Avatar size={40} id={item.avatarId} />
                            <View style={styles.profileInfo}>
                                <ThemedText style={styles.displayName}>{item.displayName}</ThemedText>
                                <ThemedText style={styles.bio} numberOfLines={2}>{item.bio}</ThemedText>
                            </View>
                        </TouchableOpacity>
                    );
                }}
            />
        );
    };

    return (
        <View style={styles.container}>
            {renderTabs()}
            {renderContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    tabs: {
        flexDirection: 'row',
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
        fontWeight: '600',
    },
    loader: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    noResults: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: 32,
    },
    userItem: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryLight,
    },
    userInfo: {
        marginLeft: 12,
        flex: 1,
    },
    username: {
        fontWeight: '600',
        fontSize: 16,
    },
    email: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    profileItem: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryLight,
    },
    profileInfo: {
        marginLeft: 12,
        flex: 1,
    },
    displayName: {
        fontWeight: '600',
        fontSize: 16,
    },
    bio: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
});

export default SearchResultsScreen;
