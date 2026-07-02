import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { PRESET_FEEDS, type FeedDescriptor, type SavedFeed } from '@mention/shared-types';
import { feedPreferencesService } from '@/services/feedPreferencesService';
import { logger } from '@/lib/logger';

/**
 * The read-only default layout for anonymous viewers: the non-auth presets in
 * their declared order, pinned per each preset's `defaultPinned`. Signed-in
 * viewers get their merged layout from the server instead.
 */
function anonSavedFeeds(): SavedFeed[] {
  return PRESET_FEEDS
    .filter((preset) => !preset.requiresAuth)
    .map((preset, index) => ({
      key: preset.id,
      descriptor: preset.descriptor,
      pinned: preset.defaultPinned,
      order: index,
    }));
}

/** A feed the caller can pin — either a preset (already saved) or a custom feed. */
export interface PinnableFeed {
  key: string;
  descriptor: FeedDescriptor;
}

export interface UseFeedPreferences {
  /** The full saved layout (presets + custom), server order. */
  savedFeeds: SavedFeed[];
  /** The pinned subset, ordered by `order`. */
  pinnedFeeds: SavedFeed[];
  /** Whether a given key is currently pinned. */
  isPinned: (key: string) => boolean;
  /** Pin a feed (adds it to the saved layout if not already present). */
  pin: (feed: PinnableFeed) => void;
  /** Unpin a feed (keeps it saved, just off the tab bar). */
  unpin: (key: string) => void;
  /** Reorder the pinned feeds to match the given key order. */
  reorder: (orderedPinnedKeys: string[]) => void;
  isLoading: boolean;
  /** Whether the viewer can persist changes (signed in). */
  canEdit: boolean;
}

/**
 * The viewer's server-persisted feed layout (saved / pinned / ordered feeds).
 *
 * Keyed on the auth identity so the layout reloads when a session resolves on
 * cold boot or an account switches; gated on `canUsePrivateApi` so the private
 * endpoint is never hit while anonymous. Anonymous viewers get a read-only
 * default catalog derived from `PRESET_FEEDS`. Pin / unpin / reorder mutate the
 * layout optimistically, PUT it, then invalidate.
 */
export function useFeedPreferences(): UseFeedPreferences {
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['feedPreferences', user?.id ?? 'anon'] as const, [user?.id]);

  const query = useQuery<SavedFeed[]>({
    queryKey,
    enabled: canUsePrivateApi,
    staleTime: 5 * 60 * 1000,
    queryFn: () => feedPreferencesService.get(),
  });

  const savedFeeds = useMemo<SavedFeed[]>(
    () => query.data ?? (canUsePrivateApi ? [] : anonSavedFeeds()),
    [query.data, canUsePrivateApi],
  );

  const mutation = useMutation<SavedFeed[], Error, SavedFeed[], { previous: SavedFeed[] | undefined }>({
    mutationFn: (next) => feedPreferencesService.update(next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SavedFeed[]>(queryKey);
      queryClient.setQueryData<SavedFeed[]>(queryKey, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<SavedFeed[]>(queryKey, context.previous);
      }
      logger.warn('Failed to persist feed preferences', { error });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const commit = useCallback(
    (next: SavedFeed[]) => {
      if (!canUsePrivateApi) return;
      mutation.mutate(next);
    },
    [canUsePrivateApi, mutation],
  );

  const pin = useCallback(
    (feed: PinnableFeed) => {
      const existing = savedFeeds.find((f) => f.key === feed.key);
      const next = existing
        ? savedFeeds.map((f) => (f.key === feed.key ? { ...f, pinned: true } : f))
        : [...savedFeeds, { key: feed.key, descriptor: feed.descriptor, pinned: true, order: savedFeeds.length }];
      commit(next);
    },
    [savedFeeds, commit],
  );

  const unpin = useCallback(
    (key: string) => {
      commit(savedFeeds.map((f) => (f.key === key ? { ...f, pinned: false } : f)));
    },
    [savedFeeds, commit],
  );

  const reorder = useCallback(
    (orderedPinnedKeys: string[]) => {
      const orderIndex = new Map(orderedPinnedKeys.map((key, index) => [key, index]));
      // Pinned feeds take the requested order; unpinned feeds keep their relative
      // order after them. `order` is a single monotonic sequence across the list.
      const pinnedInOrder = savedFeeds
        .filter((f) => f.pinned && orderIndex.has(f.key))
        .sort((a, b) => (orderIndex.get(a.key) ?? 0) - (orderIndex.get(b.key) ?? 0));
      const rest = savedFeeds.filter((f) => !(f.pinned && orderIndex.has(f.key)));
      const next = [...pinnedInOrder, ...rest].map((f, index) => ({ ...f, order: index }));
      commit(next);
    },
    [savedFeeds, commit],
  );

  const pinnedFeeds = useMemo(
    () => savedFeeds.filter((f) => f.pinned).sort((a, b) => a.order - b.order),
    [savedFeeds],
  );

  const isPinned = useCallback((key: string) => savedFeeds.some((f) => f.key === key && f.pinned), [savedFeeds]);

  return {
    savedFeeds,
    pinnedFeeds,
    isPinned,
    pin,
    unpin,
    reorder,
    isLoading: canUsePrivateApi && query.isLoading,
    canEdit: canUsePrivateApi,
  };
}
