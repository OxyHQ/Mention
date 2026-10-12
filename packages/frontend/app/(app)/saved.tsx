import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl, type DialogAction } from '@oxy.so/bloom/dialog';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { HeaderDockProvider, StickySection } from '@oxy.so/bloom/layout';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@oxy.so/bloom/search';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { Fab } from '@oxy.so/bloom/fab';
import { PageAction } from '@/components/shell/PageAction';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { feedService, type SavedPostsPage } from '@/services/feedService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { logger } from '@oxy.so/core/logger';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useScreenReselect, useTabSelect } from '@/context/ScreenReselectContext';
import SavedPostsList, { type SavedPost } from '@/components/saved/SavedPostsList';
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
  const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const queryClient = useQueryClient();
  const { scrollPosition } = useLayoutScroll();
  const cachePosts = usePostsStore((state) => state.cachePosts);
  const viewerId = user?.id;

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
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

  // The selection and an open move dialog belong to the current account.
  // AccountSwitchReset clears server query data; this resets the UI state.
  useEffect(() => {
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

  // The server's folders, and only those: a folder is created there, empty,
  // before it is shown (OxyHQ/Mention#1124 — it used to live in this
  // component's memory and vanish on reload).
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);

  const folderTabs = useMemo(
    () => [
      { id: ALL_FOLDERS_TAB_ID, label: t('saved.allBookmarks', 'All') },
      ...folders.map((folder) => ({ id: folderTabId(folder), label: folder })),
    ],
    [folders, t],
  );

  const selectFolder = useTabSelect(selectedFolder, setSelectedFolder);
  const handleFolderTabPress = useCallback(
    (tabId: string) => {
      selectFolder(tabId === ALL_FOLDERS_TAB_ID ? null : tabId.slice(FOLDER_TAB_PREFIX.length));
    },
    [selectFolder],
  );

  const savedPostsQuery = useInfiniteQuery({
    queryKey: viewerQueryKeys.savedPosts(viewerId, debouncedSearch, selectedFolder),
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
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),
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
  useScreenReselect({ refresh: refetchSavedPosts });

  const posts = useMemo(() => flattenSavedPages(savedPostsData?.pages), [savedPostsData?.pages]);

  // React Query owns saved-list pagination, while PostItem subscribes to the
  // shared post store for granular engagement updates. Seed that store from
  // every fetched page so save/unsave can update the mounted row immediately.
  useEffect(() => {
    if (posts.length > 0) {
      cachePosts(posts);
    }
  }, [cachePosts, posts]);

  const moveBookmarkMutation = useMutation({
    mutationFn: ({ postId, folder }: { postId: string; folder: string | null }) =>
      feedService.moveBookmarkToFolder(postId, folder),
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
  const { isPending: isMovingBookmark, mutate: moveBookmark } = moveBookmarkMutation;

  const closeNewFolder = useCallback(() => {
    newFolderControl.close();
    setNewFolderName('');
  }, [newFolderControl]);

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => feedService.createBookmarkFolder(name),
    retry: false,
    onSuccess: (folder) => {
      // Show it now; the refetch confirms it without holding the dialog open.
      const foldersKey = viewerQueryKeys.bookmarkFolders(viewerId);
      queryClient.setQueryData<string[]>(foldersKey, (current = []) =>
        current.includes(folder) ? current : [...current, folder],
      );
      void queryClient.invalidateQueries({ queryKey: foldersKey });
      setNewFolderName('');
      newFolderControl.close();
      setSelectedFolder(folder);
    },
    onError: (error) => {
      logger.error('Error creating bookmark folder', error);
      toast(t('saved.createFolderFailed', "Couldn't create the folder. Try again."), {
        type: 'error',
      });
    },
  });
  const { isPending: isCreatingFolder, mutate: createFolder } = createFolderMutation;

  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name || isCreatingFolder) return;
    createFolder(name);
  }, [createFolder, isCreatingFolder, newFolderName]);

  const handleMoveToFolder = useCallback(
    (folder: string | null) => {
      if (!movingPostId || isMovingBookmark) return;
      moveBookmark({
        postId: movingPostId,
        folder,
      });
    },
    [isMovingBookmark, moveBookmark, movingPostId],
  );

  const closeMoveDialog = useCallback(() => {
    setShowMoveModal(false);
    setMovingPostId(null);
  }, []);

  const moveDialogActions = useMemo<DialogAction[]>(
    () => [
      {
        label: t('common.cancel', 'Cancel'),
        color: 'cancel',
        disabled: isMovingBookmark,
      },
    ],
    [isMovingBookmark, t],
  );

  const handleLongPress = useCallback((postId: string) => {
    setMovingPostId(postId);
    setShowMoveModal(true);
  }, []);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const listEmpty = useMemo(() => {
    const initialLoading = isPrivateApiPending || (canUsePrivateApi && savedPostsPending);
    if (initialLoading) {
      return (
        <View className="items-center justify-center pt-[60px]">
          <Loading className="text-primary" size="lg" />
        </View>
      );
    }

    if (savedPostsFailed) {
      return (
        <EmptyState
          error={{
            title: t('common.error', 'Something went wrong'),
            message: t('saved.loadError', 'Saved posts could not be loaded.'),
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
        title={
          debouncedSearch
            ? t('saved.empty.search.title', 'No results found')
            : selectedFolder
              ? t('saved.empty.folder.title', 'This folder is empty')
              : t('saved.empty.title', 'No saved posts yet')
        }
        subtitle={
          debouncedSearch
            ? t(
                'saved.empty.search.subtitle',
                'No saved post matches that search. Try another term.',
              )
            : selectedFolder
              ? t(
                  'saved.empty.folder.subtitle',
                  'Long-press a saved post to move it into this folder.',
                )
              : t('saved.empty.subtitle', 'Posts you save are kept here, private to you.')
        }
        sticker={debouncedSearch ? 'searchNoResults' : 'saved'}
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
      <Loading className="text-primary" size="sm" />
    </View>
  ) : (
    <View style={styles.listFooterSpace} />
  );

  return (
    <>
      <SEO title={t('seo.saved.title')} description={t('seo.saved.description')} />
      <HeaderDockProvider scrollY={scrollPosition}>
        <View className="flex-1 web:z-auto">
          <StatusBar style={theme.isDark ? 'light' : 'dark'} />
          <PageHeader title={t('screens.saved.title')} presentation="floating" />

          {/* Search and folder tabs dock under the header. Creating a folder
                        is an action, not a section, so it lives in the FAB. */}
          <StickySection>
            <View className="mx-4 my-2">
              <Search
                label={t('saved.searchPlaceholder', 'Search saved posts')}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onClearText={() => setSearchQuery('')}
              />
            </View>
            <Tabs
              value={selectedFolder === null ? ALL_FOLDERS_TAB_ID : folderTabId(selectedFolder)}
              onValueChange={handleFolderTabPress}
              variant="underline"
            >
              {folderTabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id} label={tab.label} />
              ))}
            </Tabs>
          </StickySection>

          <SavedPostsList
            posts={posts}
            empty={listEmpty}
            footer={listFooter}
            hasNextPage={Boolean(hasNextPage)}
            onEndReached={handleEndReached}
            onLongPress={handleLongPress}
          />

          {/* Create-folder FAB — same anchor and BottomBar clearance as the
                        create action on feeds, lists and the home feed. */}
          {canUsePrivateApi ? (
            <PageAction>
              <Fab
                size="md"
                onPress={newFolderControl.open}
                icon={RiAddLine}
                accessibilityLabel={t('saved.newFolder', 'New folder')}
              />
            </PageAction>
          ) : null}
        </View>
      </HeaderDockProvider>

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
            <Button appearance="subtle" tone="neutral" size="lg" onPress={closeNewFolder}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              appearance="solid"
              tone="accent"
              size="lg"
              disabled={!newFolderName.trim() || isCreatingFolder}
              loading={isCreatingFolder}
              onPress={handleCreateFolder}
            >
              {t('common.create', 'Create')}
            </Button>
          </View>
        </View>
      </Dialog>

      <Dialog
        open={showMoveModal}
        onClose={closeMoveDialog}
        title={t('saved.moveToFolder', 'Move to Folder')}
        label={t('saved.moveToFolder', 'Move to Folder')}
        maxWidth={360}
        dismissOnBackdrop={!isMovingBookmark}
        actions={moveDialogActions}
      >
        <View className="mb-3">
          <Item
            role="option"
            title={t('saved.allBookmarks', 'All Bookmarks')}
            onPress={() => handleMoveToFolder(null)}
            disabled={isMovingBookmark}
          />
          {folders.map((folder) => (
            <Item
              key={folder}
              role="option"
              title={folder}
              onPress={() => handleMoveToFolder(folder)}
              disabled={isMovingBookmark}
            />
          ))}
        </View>
      </Dialog>
    </>
  );
};

const styles = StyleSheet.create({
  listFooterSpace: {
    height: 24,
  },
});

export default SavedPostsScreen;
