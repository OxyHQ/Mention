import React, { useState, useEffect } from 'react';
import { StyleSheet, TextInput, View, TouchableOpacity, ScrollView, ActivityIndicator, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import PostItem from '../components/Feed/PostItem';
import { colors } from '../styles/colors';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Search } from '@/assets/icons/search-icon';
import { feedService } from '../services/feedService';
import SEO from '@/components/SEO';

const SavedPostsScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const theme = useTheme();
    const { t } = useTranslation();
    const [searchQuery, setSearchQuery] = useState('');
    const [posts, setPosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);

    useEffect(() => {
        const fetchSavedPosts = async () => {
            setLoading(true);
            try {
                const response = await feedService.getSavedPosts({
                    page: 1,
                    limit: 50,
                    search: searchQuery.trim() || undefined
                });
                setPosts(response.data.posts || []);
                setPage(1);
            } catch (error) {
                console.error('Error fetching saved posts:', error);
            } finally {
                setLoading(false);
            }
        };

        const timeoutId = setTimeout(fetchSavedPosts, searchQuery.trim() ? 500 : 0);
        return () => clearTimeout(timeoutId);
    }, [searchQuery]);

    return (
        <>
            <SEO
                title={t('seo.saved.title')}
                description={t('seo.saved.description')}
            />
            <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
                <Stack.Screen
                options={{
                    title: 'Saved Posts',
                    headerShown: true,
                }}
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
                    placeholder={t("search.placeholder", "Search saved posts...")}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                />
                {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery("")}>
                        <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </View>

            <ScrollView style={styles.resultsContainer}>
                {loading && (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                    </View>
                )}

                {!loading && posts.length === 0 && (
                    <View style={styles.emptyContainer}>
                        <Search size={48} color={theme.colors.textSecondary} />
                        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                            {searchQuery.trim() 
                                ? t("search.noResults", "No results found")
                                : t("search.startSearching", "No saved posts yet")}
                        </Text>
                    </View>
                )}

                {!loading && posts.length > 0 && (
                    <View style={styles.postsContainer}>
                        {posts.map((post: any) => (
                            <PostItem key={post.id || post._id} post={post} />
                        ))}
                    </View>
                )}
            </ScrollView>
        </ThemedView>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
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
    postsContainer: {
        flex: 1,
    },
});

export default SavedPostsScreen;
