import type { QueryClient } from '@tanstack/react-query';

export type ViewerId = string | null | undefined;

const ANONYMOUS_VIEWER = 'anon';

export function viewerCacheId(viewerId: ViewerId): string {
  const normalized = viewerId?.trim();
  return normalized ? normalized : ANONYMOUS_VIEWER;
}

/**
 * Every response whose shape depends on the signed-in viewer starts with this
 * prefix. Besides preventing A/B cache collisions, the prefix gives account
 * transitions one precise namespace to cancel and remove.
 */
export const viewerQueryKeys = {
  all: (viewerId: ViewerId) => ['viewer', viewerCacheId(viewerId)] as const,
  search: (
    viewerId: ViewerId,
    tab: string,
    query: string,
    canUsePrivateApi: boolean,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'search',
    tab,
    query,
    canUsePrivateApi,
  ] as const,
  searchHistory: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'search-history',
  ] as const,
  livePresence: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'live-presence',
  ] as const,
  savedPostsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'saved-posts',
  ] as const,
  savedPosts: (
    viewerId: ViewerId,
    search: string,
    folder: string | null,
  ) => [
    ...viewerQueryKeys.savedPostsRoot(viewerId),
    search,
    folder ?? 'all',
  ] as const,
  bookmarkFolders: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'bookmark-folders',
  ] as const,
};

export function viewerStorageKey(baseKey: string, viewerId: ViewerId): string {
  return `${baseKey}:${encodeURIComponent(viewerCacheId(viewerId))}`;
}

/**
 * Remove only the previous viewer's private namespace. The next viewer has a
 * different prefix, so an in-flight response from A can never populate B's key.
 */
export async function clearViewerQueryCache(
  queryClient: QueryClient,
  viewerId: string,
): Promise<void> {
  const queryKey = viewerQueryKeys.all(viewerId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}
