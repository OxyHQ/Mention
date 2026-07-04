import React, { useState, useEffect, useCallback } from 'react';
import { Platform, StyleSheet, TextInput, View, TouchableOpacity, ScrollView, Text, Modal, Pressable } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import PostItem from '@/components/Feed/PostItem';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { Search } from '@/assets/icons/search-icon';
import { Bookmark } from '@/assets/icons/bookmark-icon';
import { useAuth } from '@oxyhq/services';
import { authenticatedClient } from '@/utils/api';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@/lib/logger';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';

const IS_WEB = Platform.OS === 'web';

type SavedPost = React.ComponentProps<typeof PostItem>['post'];

const SavedPostsScreen: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation();
    const { isAuthenticated, user } = useAuth();
    const viewerId = user?.id;
    const [searchQuery, setSearchQuery] = useState('');
    const [posts, setPosts] = useState<SavedPost[]>([]);
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
            const response = await authenticatedClient.get<{ folders?: string[] }>('/posts/bookmarks/folders');
            setFolders(response.data?.folders || []);
        } catch (error) {
            logger.error('Error fetching bookmark folders', { error });
        }
    }, []);

    // Bookmarks and saved posts are strictly per-viewer (anonymous has none),
    // so both effects gate on `isAuthenticated` and key on `viewerId`. Without
    // this they fired once during the anonymous cold-boot window and never
    // reloaded after the session restored ~5s later.
    useEffect(() => {
        if (!isAuthenticated) {
            setFolders([]);
            return;
        }
        fetchFolders();
    }, [isAuthenticated, viewerId, fetchFolders]);

    // Fetch the saved-posts list for the current search + folder. Extracted so
    // both the list effect and the "move to folder" flow can trigger the same
    // refetch.
    const fetchSavedPosts = useCallback(async () => {
        setLoading(true);
        try {
            const params: { page: number; limit: number; search?: string; folder?: string } = {
                page: 1,
                limit: 50,
            };
            if (searchQuery.trim()) {
                params.search = searchQuery.trim();
            }
            if (selectedFolder) {
                params.folder = selectedFolder;
            }
            const response = await authenticatedClient.get<{ posts?: SavedPost[] }>('/posts/saved', { params });
            setPosts(response.data?.posts || []);
            setPage(1);
        } catch (error) {
            logger.error('Error fetching saved posts', { error });
        } finally {
            setLoading(false);
        }
    }, [searchQuery, selectedFolder]);

    // Fetch saved posts
    useEffect(() => {
        if (!isAuthenticated) {
            setPosts([]);
            setLoading(false);
            return;
        }

        const timeoutId = setTimeout(fetchSavedPosts, searchQuery.trim() ? 500 : 0);
        return () => clearTimeout(timeoutId);
    }, [isAuthenticated, viewerId, searchQuery, fetchSavedPosts]);

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
            await authenticatedClient.patch(`/posts/bookmarks/${movingPostId}/folder`, { folder });
            // Refresh the folder list and the saved-posts list: a post moved out
            // of the active folder must drop off the current view immediately.
            fetchFolders();
            fetchSavedPosts();
        } catch (error) {
            logger.error('Error moving bookmark', { error });
        }
        setShowMoveModal(false);
        setMovingPostId(null);
    };

    const handleLongPress = (postId: string) => {
        setMovingPostId(postId);
        setShowMoveModal(true);
    };

    // Search bar + folder chips + the saved-posts list. This whole block scrolls
    // as the page content — it participates in the shared LAYOUT scroll (the
    // document on web, the screen's ScrollView on native) instead of owning a
    // nested `flex-1` scroller. Matches how the other list screens (notifications,
    // feeds/[id], lists/[id]) let their sub-chrome scroll with the content.
    const body = (
        <>
            <View className="flex-row items-center px-4 py-2 mx-4 my-2 rounded-3xl bg-secondary">
                <View className="mr-2">
                    <Search
                        size={20}
                        className="text-muted-foreground"
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

            {loading && (
                <View className="items-center justify-center pt-[60px]">
                    <Loading className="text-primary" size="large" />
                </View>
            )}

            {!loading && posts.length === 0 && (
                <EmptyState
                    title={searchQuery.trim()
                        ? t("search.noResults", "No results found")
                        : t("search.startSearching", "No saved posts yet")}
                    customIcon={searchQuery.trim()
                        ? <Search size={48} className="text-muted-foreground" />
                        : <Bookmark size={48} className="text-muted-foreground" />
                    }
                    containerStyle={{ paddingTop: 60 }}
                />
            )}

            {!loading && posts.length > 0 && posts.map((post) => (
                <Pressable
                    key={post.id}
                    onLongPress={() => handleLongPress(post.id)}
                    delayLongPress={500}
                >
                    <PostItem post={post} />
                </Pressable>
            ))}
        </>
    );

    return (
        <>
            <SEO
                title={t('seo.saved.title')}
                description={t('seo.saved.description')}
            />
            {/* SafeAreaView (top) + PanelStickyHeader own the panel/safe-area insets
                — the same chrome the home, notifications and hashtag screens use — so
                the header pins correctly inside the rounded panel on desktop web,
                collapses its gutter at mobile/full-bleed width, and reserves the
                status-bar inset on native. No hand-rolled `paddingTop: insets.top`. */}
            <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    {/* Title header pinned inside the rounded panel via
                        PanelStickyHeader. The saved-posts list is document-scroll on
                        web, so the header must pin at PANEL_TOP_INSET (not top:0,
                        where the bleed mask would clip it). `disableSticky` hands
                        sticky ownership to PanelStickyHeader. */}
                    <PanelStickyHeader level={0}>
                        <Header
                            options={{
                                title: t('screens.saved.title'),
                                showBackButton: false,
                            }}
                            disableSticky
                        />
                    </PanelStickyHeader>

                    {/* The body participates in the shared layout scroll: on web it
                        flows in the document (the body is the scroller — no inner
                        scroll container), on native the screen owns a single
                        ScrollView. Mirrors the home/profile scroll ownership. */}
                    {IS_WEB ? (
                        <View>{body}</View>
                    ) : (
                        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                            {body}
                        </ScrollView>
                    )}
                </ThemedView>
            </SafeAreaView>

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
