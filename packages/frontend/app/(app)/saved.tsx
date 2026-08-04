import React, {
    useCallback,
    useEffect,
    useMemo,
    useState,
} from 'react';
import {
    Modal,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { Button } from '@oxyhq/bloom/button';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { Loading } from '@oxyhq/bloom/loading';
import { Search } from '@oxyhq/bloom/search';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services/ui/client';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { Search as SearchIcon } from '@/assets/icons/search-icon';
import { Bookmark } from '@/assets/icons/bookmark-icon';
import { SEO } from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
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

// Folder tab ids are namespaced so a folder a user literally named "all" can
// never collide with the "All" tab.
const ALL_FOLDERS_TAB_ID = 'all';
const FOLDER_TAB_PREFIX = 'folder:';

const folderTabId = (folder: string) => `${FOLDER_TAB_PREFIX}${folder}`;

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
    const newFolderControl = useDialogControl();
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

    const folderTabs = useMemo(
        () => [
            { id: ALL_FOLDERS_TAB_ID, label: t('saved.allBookmarks', 'All') },
            ...folders.map((folder) => ({ id: folderTabId(folder), label: folder })),
        ],
        [folders, t],
    );

    const handleFolderTabPress = useCallback((tabId: string) => {
        setSelectedFolder(
            tabId === ALL_FOLDERS_TAB_ID ? null : tabId.slice(FOLDER_TAB_PREFIX.length),
        );
    }, []);

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

    const closeNewFolder = useCallback(() => {
        newFolderControl.close();
        setNewFolderName('');
    }, [newFolderControl]);

    const handleCreateFolder = useCallback(() => {
        const name = newFolderName.trim();
        if (!name) return;
        setLocalFolders((current) => (
            current.includes(name) ? current : [...current, name]
        ));
        setNewFolderName('');
        newFolderControl.close();
        setSelectedFolder(name);
    }, [newFolderControl, newFolderName]);

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
            <View className="mx-4 my-2">
                <Search
                    label={t('saved.searchPlaceholder', 'Search saved posts')}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    onClearText={() => setSearchQuery('')}
                />
            </View>

            {/* Folders read as sections of one collection, so they get the same
                tab bar every other sectioned screen uses (search, notifications,
                lists). Creating a folder is an action, not a section, so it lives
                in the FAB — same place as "create" on every other screen. */}
            <AnimatedTabBar
                tabs={folderTabs}
                activeTabId={selectedFolder === null ? ALL_FOLDERS_TAB_ID : folderTabId(selectedFolder)}
                onTabPress={handleFolderTabPress}
                scrollEnabled
                instanceId="saved-folders"
            />
        </View>
    ), [
        folderTabs,
        handleFolderTabPress,
        searchQuery,
        selectedFolder,
        t,
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
                    ? t('saved.empty.search.title', 'No results found')
                    : selectedFolder
                        ? t('saved.empty.folder.title', 'This folder is empty')
                        : t('saved.empty.title', 'No saved posts yet')}
                subtitle={debouncedSearch
                    ? t('saved.empty.search.subtitle', 'No saved post matches that search. Try another term.')
                    : selectedFolder
                        ? t('saved.empty.folder.subtitle', 'Long-press a saved post to move it into this folder.')
                        : t('saved.empty.subtitle', 'Posts you save are kept here, private to you.')}
                customIcon={debouncedSearch
                    ? <SearchIcon size={48} className="text-muted-foreground" />
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
        selectedFolder,
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

                {/* Create-folder FAB — same anchor and BottomBar clearance as the
                    create action on feeds, lists and the home feed. */}
                {canUsePrivateApi ? (
                    <BottomBarAwareFab
                        onPress={newFolderControl.open}
                        icon={<Ionicons name="add" size={24} color={theme.colors.tertiaryForeground} />}
                        accessibilityLabel={t('saved.newFolder', 'New folder')}
                    />
                ) : null}
            </SafeAreaView>

            <Dialog
                control={newFolderControl}
                title={t('saved.createFolder', 'Create folder')}
                label={t('saved.createFolder', 'Create folder')}
            >
                <View className="gap-4">
                    <TextField>
                        <TextFieldInput
                            label={t('saved.folderName', 'Folder name')}
                            value={newFolderName}
                            onChangeText={setNewFolderName}
                            onSubmitEditing={handleCreateFolder}
                            returnKeyType="done"
                            autoFocus
                            maxLength={100}
                        />
                    </TextField>

                    <View className="flex-row justify-end gap-2">
                        <Button variant="secondary" size="large" onPress={closeNewFolder}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            size="large"
                            disabled={!newFolderName.trim()}
                            onPress={handleCreateFolder}
                        >
                            {t('common.create', 'Create')}
                        </Button>
                    </View>
                </View>
            </Dialog>

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
                            className="px-4 py-2.5 rounded-[10px] items-center mt-3 bg-muted"
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
