import React, {
    useCallback,
    useEffect,
    useMemo,
    useState,
} from 'react';
import {
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services/ui/client';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { Search } from '@/assets/icons/search-icon';
import { Bookmark } from '@/assets/icons/bookmark-icon';
import { SEO } from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import {
    feedService,
    type SavedPostsPage,
} from '@/services/feedService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { logger } from '@oxyhq/core/logger';
import SavedPostsList, {
    type SavedPost,
} from '@/components/saved/SavedPostsList';
import { usePostsStore } from '@/stores/postsStore';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 400;

function flattenSavedPages(pages: SavedPostsPage[] | undefined): SavedPost[] {
    if (!pages) return [];

    // Page-number pagination can overlap when a bookmark changes while the user
    // scrolls. Preserve first-seen order while keeping one mounted row per post.
    const seen = new Set<string>();
    const posts: SavedPost[] = [];
    for (const page of pages) {
        for (const post of page.posts) {
            if (seen.has(post.id)) continue;
            seen.add(post.id);
            posts.push(post);
        }
    }
    return posts;
}

const SavedPostsScreen: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation();
    const {
        canUsePrivateApi,
        isPrivateApiPending,
        user,
    } = useAuth();
    const queryClient = useQueryClient();
    const cachePosts = usePostsStore((state) => state.cachePosts);
    const viewerId = user?.id;

    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
    const [localFolders, setLocalFolders] = useState<string[]>([]);
    const [showNewFolderModal, setShowNewFolderModal] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [movingPostId, setMovingPostId] = useState<string | null>(null);
    const [showMoveModal, setShowMoveModal] = useState(false);

    useEffect(() => {
        const timeout = setTimeout(
            () => setDebouncedSearch(searchQuery.trim()),
            searchQuery.trim() ? SEARCH_DEBOUNCE_MS : 0,
        );
        return () => clearTimeout(timeout);
    }, [searchQuery]);

    // A local-only folder chip belongs to the current account. AccountSwitchReset
    // clears server query data; this resets the one small piece of draft UI state.
    useEffect(() => {
        setLocalFolders([]);
        setSelectedFolder(null);
        setMovingPostId(null);
        setShowMoveModal(false);
    }, [viewerId]);

    const foldersQuery = useQuery({
        queryKey: viewerQueryKeys.bookmarkFolders(viewerId),
        queryFn: ({ signal }) => feedService.getBookmarkFolders(signal),
        enabled: canUsePrivateApi && Boolean(viewerId),
        staleTime: 30_000,
        retry: false,
    });

    const folders = useMemo(
        () => Array.from(new Set([...(foldersQuery.data ?? []), ...localFolders])),
        [foldersQuery.data, localFolders],
    );

    const savedPostsQuery = useInfiniteQuery({
        queryKey: viewerQueryKeys.savedPosts(
            viewerId,
            debouncedSearch,
            selectedFolder,
        ),
        queryFn: async ({ pageParam, signal }) => {
            const response = await feedService.getSavedPosts({
                page: pageParam,
                limit: PAGE_SIZE,
                search: debouncedSearch || undefined,
                folder: selectedFolder ?? undefined,
                signal,
            });
            return response.data;
        },
        initialPageParam: 1,
        getNextPageParam: (lastPage) => (
            lastPage.hasMore ? lastPage.page + 1 : undefined
        ),
        enabled: canUsePrivateApi && Boolean(viewerId),
        staleTime: 15_000,
        retry: false,
    });
    const {
        data: savedPostsData,
        fetchNextPage,
        hasNextPage,
        isError: savedPostsFailed,
        isFetchingNextPage,
        isPending: savedPostsPending,
        refetch: refetchSavedPosts,
    } = savedPostsQuery;

    const posts = useMemo(
        () => flattenSavedPages(savedPostsData?.pages),
        [savedPostsData?.pages],
    );

    // React Query owns saved-list pagination, while PostItem subscribes to the
    // shared post store for granular engagement updates. Seed that store from
    // every fetched page so save/unsave can update the mounted row immediately.
    useEffect(() => {
        if (posts.length > 0) {
            cachePosts(posts);
        }
    }, [cachePosts, posts]);

    const moveBookmarkMutation = useMutation({
        mutationFn: ({ postId, folder }: {
            postId: string;
            folder: string | null;
        }) => feedService.moveBookmarkToFolder(postId, folder),
        retry: false,
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: viewerQueryKeys.savedPostsRoot(viewerId),
                }),
                queryClient.invalidateQueries({
                    queryKey: viewerQueryKeys.bookmarkFolders(viewerId),
                }),
            ]);
        },
        onError: (error) => {
            logger.error('Error moving bookmark', error);
        },
        onSettled: () => {
            setShowMoveModal(false);
            setMovingPostId(null);
        },
    });
    const {
        isPending: isMovingBookmark,
        mutate: moveBookmark,
    } = moveBookmarkMutation;

    const handleCreateFolder = useCallback(() => {
        const name = newFolderName.trim();
        if (!name) return;
        setLocalFolders((current) => (
            current.includes(name) ? current : [...current, name]
        ));
        setNewFolderName('');
        setShowNewFolderModal(false);
        setSelectedFolder(name);
    }, [newFolderName]);

    const handleMoveToFolder = useCallback((folder: string | null) => {
        if (!movingPostId || isMovingBookmark) return;
        moveBookmark({
            postId: movingPostId,
            folder,
        });
    }, [isMovingBookmark, moveBookmark, movingPostId]);

    const handleLongPress = useCallback((postId: string) => {
        setMovingPostId(postId);
        setShowMoveModal(true);
    }, []);

    const handleEndReached = useCallback(() => {
        if (
            hasNextPage &&
            !isFetchingNextPage
        ) {
            void fetchNextPage();
        }
    }, [
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
    ]);

    const listHeader = useMemo(() => (
        <View>
            <View className="flex-row items-center px-4 py-2 mx-4 my-2 rounded-3xl bg-secondary">
                <View className="mr-2">
                    <Search size={20} className="text-muted-foreground" />
                </View>
                <TextInput
                    className="flex-1 text-base py-2 text-foreground"
                    placeholder={t('search.placeholder', 'Search saved posts...')}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    accessibilityLabel={t('search.placeholder', 'Search saved posts...')}
                />
                {searchQuery.length > 0 && (
                    <TouchableOpacity
                        onPress={() => setSearchQuery('')}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.clear', 'Clear search')}
                    >
                        <Ionicons
                            name="close-circle"
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                    </TouchableOpacity>
                )}
            </View>

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.folderScrollContainer}
                contentContainerStyle={styles.folderScrollContent}
                keyboardShouldPersistTaps="handled"
            >
                <TouchableOpacity
                    style={[
                        styles.folderChip,
                        {
                            backgroundColor: selectedFolder === null
                                ? theme.colors.primary
                                : theme.colors.backgroundSecondary,
                            borderColor: selectedFolder === null
                                ? theme.colors.primary
                                : theme.colors.border,
                        },
                    ]}
                    onPress={() => setSelectedFolder(null)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedFolder === null }}
                >
                    <Text
                        className="text-sm font-medium"
                        style={{
                            color: selectedFolder === null
                                ? '#fff'
                                : theme.colors.text,
                        }}
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
                                backgroundColor: selectedFolder === folder
                                    ? theme.colors.primary
                                    : theme.colors.backgroundSecondary,
                                borderColor: selectedFolder === folder
                                    ? theme.colors.primary
                                    : theme.colors.border,
                            },
                        ]}
                        onPress={() => setSelectedFolder(folder)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: selectedFolder === folder }}
                    >
                        <Text
                            className="text-sm font-medium"
                            style={{
                                color: selectedFolder === folder
                                    ? '#fff'
                                    : theme.colors.text,
                            }}
                        >
                            {folder}
                        </Text>
                    </TouchableOpacity>
                ))}

                <TouchableOpacity
                    style={[
                        styles.folderChip,
                        {
                            borderColor: theme.colors.border,
                            backgroundColor: 'transparent',
                        },
                    ]}
                    onPress={() => setShowNewFolderModal(true)}
                    accessibilityRole="button"
                    accessibilityLabel={t('saved.newFolder', 'New folder')}
                >
                    <Ionicons name="add" size={16} color={theme.colors.primary} />
                    <Text className="text-sm font-medium text-primary">
                        {t('saved.newFolder', 'New')}
                    </Text>
                </TouchableOpacity>
            </ScrollView>
        </View>
    ), [
        folders,
        searchQuery,
        selectedFolder,
        t,
        theme.colors.backgroundSecondary,
        theme.colors.border,
        theme.colors.primary,
        theme.colors.text,
        theme.colors.textSecondary,
    ]);

    const listEmpty = useMemo(() => {
        const initialLoading = isPrivateApiPending || (
            canUsePrivateApi && savedPostsPending
        );
        if (initialLoading) {
            return (
                <View className="items-center justify-center pt-[60px]">
                    <Loading className="text-primary" size="large" />
                </View>
            );
        }

        if (savedPostsFailed) {
            return (
                <EmptyState
                    error={{
                        title: t('common.error', 'Something went wrong'),
                        message: t(
                            'saved.loadError',
                            'Saved posts could not be loaded.',
                        ),
                        onRetry: async () => {
                            await refetchSavedPosts();
                        },
                    }}
                    icon={{ name: 'cloud-offline-outline' }}
                    containerStyle={{ paddingTop: 60 }}
                />
            );
        }

        return (
            <EmptyState
                title={debouncedSearch
                    ? t('search.noResults', 'No results found')
                    : t('search.startSearching', 'No saved posts yet')}
                customIcon={debouncedSearch
                    ? <Search size={48} className="text-muted-foreground" />
                    : <Bookmark size={48} className="text-muted-foreground" />}
                containerStyle={{ paddingTop: 60 }}
            />
        );
    }, [
        canUsePrivateApi,
        debouncedSearch,
        isPrivateApiPending,
        refetchSavedPosts,
        savedPostsFailed,
        savedPostsPending,
        t,
    ]);

    const listFooter = isFetchingNextPage ? (
        <View className="items-center justify-center py-4">
            <Loading className="text-primary" size="small" />
        </View>
    ) : <View style={styles.listFooterSpace} />;

    return (
        <>
            <SEO
                title={t('seo.saved.title')}
                description={t('seo.saved.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? 'light' : 'dark'} />
                    <PanelStickyHeader level={0}>
                        <Header
                            options={{
                                title: t('screens.saved.title'),
                                showBackButton: false,
                            }}
                            disableSticky
                        />
                    </PanelStickyHeader>

                    <SavedPostsList
                        posts={posts}
                        header={listHeader}
                        empty={listEmpty}
                        footer={listFooter}
                        hasNextPage={Boolean(hasNextPage)}
                        onEndReached={handleEndReached}
                        onLongPress={handleLongPress}
                        backgroundColor={theme.colors.background}
                    />
                </ThemedView>
            </SafeAreaView>

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
                                onPress={() => {
                                    setShowNewFolderModal(false);
                                    setNewFolderName('');
                                }}
                            >
                                <Text className="text-foreground">
                                    {t('common.cancel', 'Cancel')}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                className="px-4 py-2.5 rounded-[10px] items-center bg-primary"
                                onPress={handleCreateFolder}
                            >
                                <Text className="text-white">
                                    {t('common.create', 'Create')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            <Modal visible={showMoveModal} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <View className="w-full max-w-[360px] rounded-2xl p-5 bg-card">
                        <Text className="text-lg font-semibold mb-4 text-foreground">
                            {t('saved.moveToFolder', 'Move to Folder')}
                        </Text>
                        <TouchableOpacity
                            style={[
                                styles.moveOption,
                                { borderColor: theme.colors.border },
                            ]}
                            onPress={() => handleMoveToFolder(null)}
                            disabled={isMovingBookmark}
                        >
                            <Text className="text-foreground">
                                {t('saved.allBookmarks', 'All Bookmarks')}
                            </Text>
                        </TouchableOpacity>
                        {folders.map((folder) => (
                            <TouchableOpacity
                                key={folder}
                                style={[
                                    styles.moveOption,
                                    { borderColor: theme.colors.border },
                                ]}
                                onPress={() => handleMoveToFolder(folder)}
                                disabled={isMovingBookmark}
                            >
                                <Text className="text-foreground">{folder}</Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            className="px-4 py-2.5 rounded-[10px] items-center mt-3 bg-secondary"
                            onPress={() => {
                                setShowMoveModal(false);
                                setMovingPostId(null);
                            }}
                            disabled={isMovingBookmark}
                        >
                            <Text className="text-foreground">
                                {t('common.cancel', 'Cancel')}
                            </Text>
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
    listFooterSpace: {
        height: 24,
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
