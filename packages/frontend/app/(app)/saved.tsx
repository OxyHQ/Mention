import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, TextInput, View, TouchableOpacity, ScrollView, Text, Modal, Pressable } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import PostItem from '@/components/Feed/PostItem';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Search } from '@/assets/icons/search-icon';
import { feedService } from '@/services/feedService';
import { authenticatedClient } from '@/utils/api';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';

const SavedPostsScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const theme = useTheme();
    const { t } = useTranslation();
    const [searchQuery, setSearchQuery] = useState('');
    const [posts, setPosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);

    // Folder state
    const [folders, setFolders] = useState<string[]>([]);
    const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
    const [showNewFolderModal, setShowNewFolderModal] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [movingPostId, setMovingPostId] = useState<string | null>(null);
    const [showMoveModal, setShowMoveModal] = useState(false);

    // Fetch folders
    const fetchFolders = useCallback(async () => {
        try {
            const response = await authenticatedClient.get('/posts/bookmarks/folders');
            setFolders(response.data?.folders || []);
        } catch (error) {
            console.error('Error fetching bookmark folders:', error);
        }
    }, []);

    useEffect(() => {
        fetchFolders();
    }, [fetchFolders]);

    // Fetch saved posts
    useEffect(() => {
        const fetchSavedPosts = async () => {
            setLoading(true);
            try {
                const params: any = {
                    page: 1,
                    limit: 50,
                };
                if (searchQuery.trim()) {
                    params.search = searchQuery.trim();
                }
                if (selectedFolder) {
                    params.folder = selectedFolder;
                }
                const response = await authenticatedClient.get('/posts/saved', { params });
                setPosts(response.data?.posts || []);
                setPage(1);
            } catch (error) {
                console.error('Error fetching saved posts:', error);
            } finally {
                setLoading(false);
            }
        };

        const timeoutId = setTimeout(fetchSavedPosts, searchQuery.trim() ? 500 : 0);
        return () => clearTimeout(timeoutId);
    }, [searchQuery, selectedFolder]);

    const handleCreateFolder = async () => {
        const name = newFolderName.trim();
        if (!name) return;
        if (!folders.includes(name)) {
            setFolders(prev => [...prev, name]);
        }
        setNewFolderName('');
        setShowNewFolderModal(false);
        setSelectedFolder(name);
    };

    const handleMoveToFolder = async (folder: string | null) => {
        if (!movingPostId) return;
        try {
            // Find the bookmark by postId - we need to query bookmarks
            const savedResponse = await authenticatedClient.get('/posts/saved', { params: { limit: 100 } });
            // The backend returns hydrated posts, but we need the bookmark ID.
            // We'll use a PATCH with the post ID approach instead
            // For simplicity, move by finding bookmarks on backend
            await authenticatedClient.patch(`/posts/bookmarks/${movingPostId}/folder`, { folder });
            // Refresh
            fetchFolders();
        } catch (error) {
            console.error('Error moving bookmark:', error);
        }
        setShowMoveModal(false);
        setMovingPostId(null);
    };

    const handleLongPress = (postId: string) => {
        setMovingPostId(postId);
        setShowMoveModal(true);
    };

    return (
        <>
            <SEO
                title={t('seo.saved.title')}
                description={t('seo.saved.description')}
            />
            <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                <Stack.Screen
                    options={{
                        title: 'Saved Posts',
                        headerShown: true,
                    }}
                />

                <View className="flex-row items-center px-4 py-2 mx-4 my-2 rounded-3xl bg-secondary">
                    <View className="mr-2">
                        <Search
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                    </View>
                    <TextInput
                        className="flex-1 text-base py-2 text-foreground"
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

                {/* Folder chips */}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.folderScrollContainer}
                    contentContainerStyle={styles.folderScrollContent}
                >
                    <TouchableOpacity
                        style={[
                            styles.folderChip,
                            {
                                backgroundColor: selectedFolder === null ? theme.colors.primary : theme.colors.backgroundSecondary,
                                borderColor: selectedFolder === null ? theme.colors.primary : theme.colors.border,
                            },
                        ]}
                        onPress={() => setSelectedFolder(null)}
                    >
                        <Text
                            className="text-sm font-medium"
                            style={{ color: selectedFolder === null ? '#fff' : theme.colors.text }}
                        >
                            {t('saved.allBookmarks', 'All')}
                        </Text>
                    </TouchableOpacity>

                    {folders.map((folder) => (
                        <TouchableOpacity
                            key={folder}
                            style={[
                                styles.folderChip,
                                {
                                    backgroundColor: selectedFolder === folder ? theme.colors.primary : theme.colors.backgroundSecondary,
                                    borderColor: selectedFolder === folder ? theme.colors.primary : theme.colors.border,
                                },
                            ]}
                            onPress={() => setSelectedFolder(folder)}
                        >
                            <Text
                                className="text-sm font-medium"
                                style={{ color: selectedFolder === folder ? '#fff' : theme.colors.text }}
                            >
                                {folder}
                            </Text>
                        </TouchableOpacity>
                    ))}

                    <TouchableOpacity
                        style={[styles.folderChip, { borderColor: theme.colors.border, backgroundColor: 'transparent' }]}
                        onPress={() => setShowNewFolderModal(true)}
                    >
                        <Ionicons name="add" size={16} color={theme.colors.primary} />
                        <Text className="text-sm font-medium text-primary">
                            {t('saved.newFolder', 'New')}
                        </Text>
                    </TouchableOpacity>
                </ScrollView>

                <ScrollView className="flex-1">
                    {loading && (
                        <View className="flex-1 items-center justify-center pt-[60px]">
                            <Loading size="large" />
                        </View>
                    )}

                    {!loading && posts.length === 0 && (
                        <EmptyState
                            title={searchQuery.trim()
                                ? t("search.noResults", "No results found")
                                : t("search.startSearching", "No saved posts yet")}
                            customIcon={<Search size={48} color={theme.colors.textSecondary} />}
                            containerStyle={{ flex: 1, paddingTop: 60 }}
                        />
                    )}

                    {!loading && posts.length > 0 && (
                        <View className="flex-1">
                            {posts.map((post: any) => (
                                <Pressable
                                    key={post.id || post._id}
                                    onLongPress={() => handleLongPress(post.id || post._id)}
                                    delayLongPress={500}
                                >
                                    <PostItem post={post} />
                                </Pressable>
                            ))}
                        </View>
                    )}
                </ScrollView>
            </ThemedView>

            {/* New Folder Modal */}
            <Modal visible={showNewFolderModal} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <View className="w-full max-w-[360px] rounded-2xl p-5 bg-card">
                        <Text className="text-lg font-semibold mb-4 text-foreground">
                            {t('saved.createFolder', 'Create Folder')}
                        </Text>
                        <TextInput
                            className="text-base p-3 mb-4 rounded-xl border text-foreground border-border bg-secondary"
                            placeholder={t('saved.folderName', 'Folder name')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={newFolderName}
                            onChangeText={setNewFolderName}
                            autoFocus
                            maxLength={100}
                        />
                        <View className="flex-row justify-end gap-2">
                            <TouchableOpacity
                                className="px-4 py-2.5 rounded-[10px] items-center bg-secondary"
                                onPress={() => { setShowNewFolderModal(false); setNewFolderName(''); }}
                            >
                                <Text className="text-foreground">{t('common.cancel', 'Cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                className="px-4 py-2.5 rounded-[10px] items-center bg-primary"
                                onPress={handleCreateFolder}
                            >
                                <Text className="text-white">{t('common.create', 'Create')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Move to Folder Modal */}
            <Modal visible={showMoveModal} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <View className="w-full max-w-[360px] rounded-2xl p-5 bg-card">
                        <Text className="text-lg font-semibold mb-4 text-foreground">
                            {t('saved.moveToFolder', 'Move to Folder')}
                        </Text>
                        <TouchableOpacity
                            style={[styles.moveOption, { borderColor: theme.colors.border }]}
                            onPress={() => handleMoveToFolder(null)}
                        >
                            <Text className="text-foreground">
                                {t('saved.allBookmarks', 'All Bookmarks')}
                            </Text>
                        </TouchableOpacity>
                        {folders.map((folder) => (
                            <TouchableOpacity
                                key={folder}
                                style={[styles.moveOption, { borderColor: theme.colors.border }]}
                                onPress={() => handleMoveToFolder(folder)}
                            >
                                <Text className="text-foreground">{folder}</Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            className="px-4 py-2.5 rounded-[10px] items-center mt-3 bg-secondary"
                            onPress={() => { setShowMoveModal(false); setMovingPostId(null); }}
                        >
                            <Text className="text-foreground">{t('common.cancel', 'Cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    folderScrollContainer: {
        maxHeight: 44,
        marginBottom: 4,
    },
    folderScrollContent: {
        paddingHorizontal: 16,
        gap: 8,
        alignItems: 'center',
    },
    folderChip: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 20,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    moveOption: {
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});

export default SavedPostsScreen;
