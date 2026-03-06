import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, TextInput, View, TouchableOpacity, ScrollView, Text, Modal, Pressable } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import PostItem from '@/components/Feed/PostItem';
import { colors } from '@/styles/colors';
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
                        <Text style={[
                            styles.folderChipText,
                            { color: selectedFolder === null ? '#fff' : theme.colors.text },
                        ]}>
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
                            <Text style={[
                                styles.folderChipText,
                                { color: selectedFolder === folder ? '#fff' : theme.colors.text },
                            ]}>
                                {folder}
                            </Text>
                        </TouchableOpacity>
                    ))}

                    <TouchableOpacity
                        style={[styles.folderChip, styles.newFolderChip, { borderColor: theme.colors.border }]}
                        onPress={() => setShowNewFolderModal(true)}
                    >
                        <Ionicons name="add" size={16} color={theme.colors.primary} />
                        <Text style={[styles.folderChipText, { color: theme.colors.primary }]}>
                            {t('saved.newFolder', 'New')}
                        </Text>
                    </TouchableOpacity>
                </ScrollView>

                <ScrollView style={styles.resultsContainer}>
                    {loading && (
                        <View style={styles.loadingContainer}>
                            <Loading size="large" />
                        </View>
                    )}

                    {!loading && posts.length === 0 && (
                        <EmptyState
                            title={searchQuery.trim()
                                ? t("search.noResults", "No results found")
                                : t("search.startSearching", "No saved posts yet")}
                            customIcon={<Search size={48} color={theme.colors.textSecondary} />}
                            containerStyle={styles.emptyContainer}
                        />
                    )}

                    {!loading && posts.length > 0 && (
                        <View style={styles.postsContainer}>
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
                    <View style={[styles.modalContent, { backgroundColor: theme.colors.card }]}>
                        <Text style={[styles.modalTitle, { color: theme.colors.text }]}>
                            {t('saved.createFolder', 'Create Folder')}
                        </Text>
                        <TextInput
                            style={[styles.modalInput, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                            placeholder={t('saved.folderName', 'Folder name')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={newFolderName}
                            onChangeText={setNewFolderName}
                            autoFocus
                            maxLength={100}
                        />
                        <View style={styles.modalActions}>
                            <TouchableOpacity
                                style={[styles.modalButton, { backgroundColor: theme.colors.backgroundSecondary }]}
                                onPress={() => { setShowNewFolderModal(false); setNewFolderName(''); }}
                            >
                                <Text style={{ color: theme.colors.text }}>{t('common.cancel', 'Cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.modalButton, { backgroundColor: theme.colors.primary }]}
                                onPress={handleCreateFolder}
                            >
                                <Text style={{ color: '#fff' }}>{t('common.create', 'Create')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Move to Folder Modal */}
            <Modal visible={showMoveModal} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <View style={[styles.modalContent, { backgroundColor: theme.colors.card }]}>
                        <Text style={[styles.modalTitle, { color: theme.colors.text }]}>
                            {t('saved.moveToFolder', 'Move to Folder')}
                        </Text>
                        <TouchableOpacity
                            style={[styles.moveOption, { borderColor: theme.colors.border }]}
                            onPress={() => handleMoveToFolder(null)}
                        >
                            <Text style={{ color: theme.colors.text }}>
                                {t('saved.allBookmarks', 'All Bookmarks')}
                            </Text>
                        </TouchableOpacity>
                        {folders.map((folder) => (
                            <TouchableOpacity
                                key={folder}
                                style={[styles.moveOption, { borderColor: theme.colors.border }]}
                                onPress={() => handleMoveToFolder(folder)}
                            >
                                <Text style={{ color: theme.colors.text }}>{folder}</Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            style={[styles.modalButton, { backgroundColor: theme.colors.backgroundSecondary, marginTop: 12 }]}
                            onPress={() => { setShowMoveModal(false); setMovingPostId(null); }}
                        >
                            <Text style={{ color: theme.colors.text }}>{t('common.cancel', 'Cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
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
    newFolderChip: {
        backgroundColor: 'transparent',
    },
    folderChipText: {
        fontSize: 14,
        fontWeight: '500',
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
        paddingTop: 60,
    },
    postsContainer: {
        flex: 1,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    modalContent: {
        width: '100%',
        maxWidth: 360,
        borderRadius: 16,
        padding: 20,
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16,
    },
    modalInput: {
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        fontSize: 16,
        marginBottom: 16,
    },
    modalActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    modalButton: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 10,
        alignItems: 'center',
    },
    moveOption: {
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});

export default SavedPostsScreen;
